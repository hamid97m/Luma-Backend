import { db } from '../db.js'
import { sendBroadcastMessage, forwardBroadcastMessage } from '../bot.js'
import { getPurchaseMessageConfig, type PurchaseMessageConfig } from './purchaseMessageConfig.js'

// The message goes out ~5 min after a checkout starts (the per-payment path).
export const FOLLOWUP_DELAY_MS = 5 * 60 * 1000
const GRACE_MS = 5 * 60 * 1000 // backstop: only sweep attempts already past the follow-up delay
const CAP = 200                // max users messaged per backstop run
const BATCH = 25
const PAUSE_MS = 1000
const CANDIDATE_LIMIT = 1000

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const isBlocked = (err: any) => err?.error_code === 403

export interface PurchaseMessageStats {
  eligible: number
  sent: number
  blocked: number
  failed: number
}

type Deliver = (telegramId: number) => Promise<void>
type Logger = { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void }

export interface PurchaseMessageDeps {
  db?: any
  log?: Logger
  now?: number
  sendText?: (telegramId: number, text: string, button?: any) => Promise<void>
  forward?: (telegramId: number, chatId: string, messageId: number) => Promise<void>
  getConfig?: (dbClient: any) => Promise<PurchaseMessageConfig | null>
}

export interface RunPurchaseMessageJobDeps extends PurchaseMessageDeps {
  graceMs?: number
  cap?: number
  batchSize?: number
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** True when the config holds a deliverable message (text has body / forward has
 * a parsed source). Guards an enabled-but-empty config from sending nothing. */
function isDeliverable(cfg: PurchaseMessageConfig): boolean {
  if (cfg.kind === 'forward') return !!cfg.sourceChatId && cfg.sourceMessageId != null
  return !!(cfg.message && cfg.message.trim())
}

function buildDeliver(cfg: PurchaseMessageConfig, deps: PurchaseMessageDeps): Deliver {
  const sendText = deps.sendText ?? sendBroadcastMessage
  const forward = deps.forward ?? forwardBroadcastMessage
  return (telegramId: number) =>
    cfg.kind === 'forward'
      ? forward(telegramId, cfg.sourceChatId!, cfg.sourceMessageId!)
      : sendText(telegramId, cfg.message!.trim(), cfg.button ?? undefined)
}

/** Atomically claim a user by inserting their sends row BEFORE sending. The
 * primary-key on user_id means only one caller (per-payment timer OR backstop
 * sweep) wins the claim — the other sees the conflict and skips, so a user is
 * never double-messaged. Returns false when already claimed or the insert failed
 * (either way we must not send without a recorded claim). */
async function claimUser(dbClient: any, userId: string): Promise<boolean> {
  const { error } = await dbClient.from('purchase_message_sends').insert({ user_id: userId, status: 'sent' })
  return !error
}

async function setStatus(dbClient: any, userId: string, status: 'sent' | 'blocked') {
  try { await dbClient.from('purchase_message_sends').update({ status }).eq('user_id', userId) } catch { /* best-effort */ }
}
async function releaseClaim(dbClient: any, userId: string) {
  try { await dbClient.from('purchase_message_sends').delete().eq('user_id', userId) } catch { /* best-effort */ }
}

/** Claim → deliver → finalize one recipient. 403 records 'blocked' (never retry);
 * a transient error releases the claim so a later run/timer retries. */
async function deliverToUser(
  dbClient: any, deliver: Deliver, target: { id: string; telegram_id: number }, stats: PurchaseMessageStats, log?: Logger,
) {
  if (!(await claimUser(dbClient, target.id))) return // someone else has it (or transient insert error)
  try {
    await deliver(target.telegram_id)
    stats.sent++
  } catch (err) {
    if (isBlocked(err)) {
      stats.blocked++
      await setStatus(dbClient, target.id, 'blocked')
    } else {
      stats.failed++
      await releaseClaim(dbClient, target.id)
      log?.warn?.({ err, userId: target.id }, 'purchase-message send failed')
    }
  }
}

/** Load one user IFF they are eligible right now: has a pending (unpaid) purchase
 * attempt on/after the cutoff, never completed a purchase, hasn't been messaged,
 * and is a messageable real user. Returns null otherwise. */
async function loadEligibleTargetForUser(
  dbClient: any, activeSince: string, userId: string,
): Promise<{ id: string; telegram_id: number } | null> {
  const { data: paid } = await dbClient
    .from('premium_transactions').select('id')
    .eq('user_id', userId).eq('source', 'purchase').eq('status', 'paid').limit(1)
  if (paid?.length) return null

  const { data: pending } = await dbClient
    .from('premium_transactions').select('id')
    .eq('user_id', userId).eq('source', 'purchase').eq('status', 'pending_payment')
    .gte('created_at', activeSince).limit(1)
  if (!pending?.length) return null

  const { data: sent } = await dbClient
    .from('purchase_message_sends').select('user_id').eq('user_id', userId).limit(1)
  if (sent?.length) return null

  const { data: users } = await dbClient
    .from('users').select('id, telegram_id')
    .eq('id', userId).eq('is_seed', false).is('banned_at', null).is('deleted_at', null)
    .gt('telegram_id', 0).or('allows_write_to_pm.is.null,allows_write_to_pm.eq.true').limit(1)
  return users?.[0] ?? null
}

/**
 * Per-payment path (primary): 5 min after a checkout starts, message this one
 * user if their purchase is still unpaid and they've never been messaged. O(1)
 * work — a couple of indexed lookups + one send — so it adds negligible load.
 */
export async function maybeSendPurchaseMessageForUser(userId: string, deps: PurchaseMessageDeps = {}): Promise<PurchaseMessageStats> {
  const dbClient = deps.db ?? db
  const getConfig = deps.getConfig ?? getPurchaseMessageConfig
  const stats: PurchaseMessageStats = { eligible: 0, sent: 0, blocked: 0, failed: 0 }

  const cfg = await getConfig(dbClient)
  if (!cfg || !cfg.enabled || !isDeliverable(cfg)) return stats

  const activeSince = cfg.activeSince ?? new Date(0).toISOString()
  const target = await loadEligibleTargetForUser(dbClient, activeSince, userId)
  if (!target) return stats

  stats.eligible = 1
  await deliverToUser(dbClient, buildDeliver(cfg, deps), target, stats, deps.log)
  return stats
}

/** Arm the per-payment 5-min check. Fire-and-forget, in-memory (cheap); the
 * backstop sweep covers checks lost to a restart/sleep during the window.
 * Skipped outside production (dev/tests never arm real timers). */
export function schedulePurchaseCheckoutFollowup(userId: string, deps: PurchaseMessageDeps = {}, delayMs = FOLLOWUP_DELAY_MS): void {
  if (process.env.NODE_ENV !== 'production') return
  setTimeout(() => {
    maybeSendPurchaseMessageForUser(userId, deps).catch((err) =>
      (deps.log?.warn ?? console.warn)({ err, userId }, 'purchase-message follow-up failed'))
  }, delayMs)
}

/**
 * Backstop sweep: catches per-payment checks lost to a restart/sleep. Finds
 * users with an unpaid purchase attempt older than the grace window who were
 * never paid and never messaged, then messages them once. Runs infrequently and
 * is bounded (cap + batches + pauses), so it adds little load.
 */
export async function runPurchaseMessageJob(deps: RunPurchaseMessageJobDeps = {}): Promise<PurchaseMessageStats> {
  const dbClient = deps.db ?? db
  const now = deps.now ?? Date.now()
  const graceMs = deps.graceMs ?? GRACE_MS
  const cap = deps.cap ?? CAP
  const batchSize = deps.batchSize ?? BATCH
  const pauseMs = deps.pauseMs ?? PAUSE_MS
  const sleep = deps.sleep ?? defaultSleep
  const getConfig = deps.getConfig ?? getPurchaseMessageConfig
  const empty: PurchaseMessageStats = { eligible: 0, sent: 0, blocked: 0, failed: 0 }

  const cfg = await getConfig(dbClient)
  if (!cfg || !cfg.enabled || !isDeliverable(cfg)) return empty

  const cutoffIso = new Date(now - graceMs).toISOString()
  const activeSince = cfg.activeSince ?? new Date(0).toISOString()

  const { data: attempts, error: attemptsErr } = await dbClient
    .from('premium_transactions')
    .select('user_id')
    .eq('source', 'purchase')
    .eq('status', 'pending_payment')
    .lte('created_at', cutoffIso)
    .gte('created_at', activeSince)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_LIMIT)
  if (attemptsErr) throw attemptsErr
  const candidateIds = [...new Set((attempts ?? []).map((r: any) => r.user_id).filter(Boolean))]
  if (candidateIds.length === 0) return empty

  const { data: paidRows, error: paidErr } = await dbClient
    .from('premium_transactions').select('user_id')
    .eq('source', 'purchase').eq('status', 'paid').in('user_id', candidateIds)
  if (paidErr) throw paidErr
  const paid = new Set((paidRows ?? []).map((r: any) => r.user_id))

  const { data: sentRows, error: sentErr } = await dbClient
    .from('purchase_message_sends').select('user_id').in('user_id', candidateIds)
  if (sentErr) throw sentErr
  const alreadySent = new Set((sentRows ?? []).map((r: any) => r.user_id))

  const freshIds = candidateIds.filter((id) => !paid.has(id) && !alreadySent.has(id))
  if (freshIds.length === 0) return empty

  const { data: users, error: usersErr } = await dbClient
    .from('users').select('id, telegram_id')
    .in('id', freshIds).eq('is_seed', false).is('banned_at', null).is('deleted_at', null)
    .gt('telegram_id', 0).or('allows_write_to_pm.is.null,allows_write_to_pm.eq.true').limit(cap)
  if (usersErr) throw usersErr
  const targets = (users ?? []) as { id: string; telegram_id: number }[]

  const stats: PurchaseMessageStats = { eligible: targets.length, sent: 0, blocked: 0, failed: 0 }
  const deliver = buildDeliver(cfg, deps)

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    await Promise.all(batch.map((t) => deliverToUser(dbClient, deliver, t, stats, deps.log)))
    if (i + batchSize < targets.length) await sleep(pauseMs)
  }

  deps.log?.info?.({ stats }, 'purchase-message backstop sweep complete')
  return stats
}
