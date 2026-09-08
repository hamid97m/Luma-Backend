import { db } from '../db.js'
import { sendBroadcastMessage, forwardBroadcastMessage } from '../bot.js'
import { getPurchaseMessageConfig, type PurchaseMessageConfig } from './purchaseMessageConfig.js'

const GRACE_MS = 30 * 60 * 1000 // don't message someone mid-checkout
const CAP = 200                 // max users messaged per run
const BATCH = 25
const PAUSE_MS = 1000
const CANDIDATE_LIMIT = 1000    // bound the abandoned-attempt scan per run

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const isBlocked = (err: any) => err?.error_code === 403

export interface PurchaseMessageStats {
  eligible: number
  sent: number
  blocked: number
  failed: number
}

export interface RunPurchaseMessageJobDeps {
  db?: any
  log?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void }
  now?: number
  graceMs?: number
  cap?: number
  batchSize?: number
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
  sendText?: (telegramId: number, text: string, button?: any) => Promise<void>
  forward?: (telegramId: number, chatId: string, messageId: number) => Promise<void>
  getConfig?: (dbClient: any) => Promise<PurchaseMessageConfig | null>
}

/** True when the config holds a deliverable message (text has body / forward has
 * a parsed source). Guards against an enabled-but-empty config sending nothing. */
function isDeliverable(cfg: PurchaseMessageConfig): boolean {
  if (cfg.kind === 'forward') return !!cfg.sourceChatId && cfg.sourceMessageId != null
  return !!(cfg.message && cfg.message.trim())
}

/**
 * One pass of the abandoned-checkout nudge: find users who started a premium
 * purchase (`source='purchase'`) but never completed it, and haven't been
 * messaged before, then send them the configured message exactly once.
 *
 * Eligibility (all must hold):
 *  - a pending_payment purchase attempt created ≥ config.active_since AND older
 *    than the grace window (so we never nag someone mid-payment)
 *  - no `paid` purchase transaction ever (they didn't complete)
 *  - no existing purchase_message_sends row (never messaged)
 *  - messageable real user (not seed, real telegram_id, not banned/deleted, opted in)
 */
export async function runPurchaseMessageJob(deps: RunPurchaseMessageJobDeps = {}): Promise<PurchaseMessageStats> {
  const dbClient = deps.db ?? db
  const now = deps.now ?? Date.now()
  const graceMs = deps.graceMs ?? GRACE_MS
  const cap = deps.cap ?? CAP
  const batchSize = deps.batchSize ?? BATCH
  const pauseMs = deps.pauseMs ?? PAUSE_MS
  const sleep = deps.sleep ?? defaultSleep
  const sendText = deps.sendText ?? sendBroadcastMessage
  const forward = deps.forward ?? forwardBroadcastMessage
  const getConfig = deps.getConfig ?? getPurchaseMessageConfig
  const empty: PurchaseMessageStats = { eligible: 0, sent: 0, blocked: 0, failed: 0 }

  const cfg = await getConfig(dbClient)
  if (!cfg || !cfg.enabled || !isDeliverable(cfg)) return empty

  const cutoffIso = new Date(now - graceMs).toISOString()
  const activeSince = cfg.activeSince ?? new Date(0).toISOString()

  // 1) Candidate abandoned attempts: pending, past the grace window, on/after the cutoff.
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

  // 2) Drop anyone who ever completed a purchase.
  const { data: paidRows, error: paidErr } = await dbClient
    .from('premium_transactions')
    .select('user_id')
    .eq('source', 'purchase')
    .eq('status', 'paid')
    .in('user_id', candidateIds)
  if (paidErr) throw paidErr
  const paid = new Set((paidRows ?? []).map((r: any) => r.user_id))

  // 3) Drop anyone already messaged.
  const { data: sentRows, error: sentErr } = await dbClient
    .from('purchase_message_sends')
    .select('user_id')
    .in('user_id', candidateIds)
  if (sentErr) throw sentErr
  const alreadySent = new Set((sentRows ?? []).map((r: any) => r.user_id))

  const freshIds = candidateIds.filter((id) => !paid.has(id) && !alreadySent.has(id))
  if (freshIds.length === 0) return empty

  // 4) Resolve to messageable real users (opted in), capped per run.
  const { data: users, error: usersErr } = await dbClient
    .from('users')
    .select('id, telegram_id')
    .in('id', freshIds)
    .eq('is_seed', false)
    .is('banned_at', null)
    .is('deleted_at', null)
    .gt('telegram_id', 0)
    .or('allows_write_to_pm.is.null,allows_write_to_pm.eq.true')
    .limit(cap)
  if (usersErr) throw usersErr
  const targets = (users ?? []) as { id: string; telegram_id: number }[]

  const stats: PurchaseMessageStats = { eligible: targets.length, sent: 0, blocked: 0, failed: 0 }

  const deliver = (telegramId: number): Promise<void> =>
    cfg.kind === 'forward'
      ? forward(telegramId, cfg.sourceChatId!, cfg.sourceMessageId!)
      : sendText(telegramId, cfg.message!.trim(), cfg.button ?? undefined)

  const record = async (userId: string, status: 'sent' | 'blocked') => {
    // upsert-ish: ignore a duplicate-key race between concurrent runs.
    try { await dbClient.from('purchase_message_sends').insert({ user_id: userId, status }) } catch { /* best-effort */ }
  }

  const handle = async (target: { id: string; telegram_id: number }) => {
    try {
      await deliver(target.telegram_id)
      stats.sent++
      await record(target.id, 'sent')
    } catch (err) {
      if (isBlocked(err)) {
        // The user blocked the bot — count it and never retry (record as blocked).
        stats.blocked++
        await record(target.id, 'blocked')
      } else {
        // Transient error — do NOT record, so the next run retries this user.
        stats.failed++
        deps.log?.warn?.({ err, userId: target.id }, 'purchase-message send failed')
      }
    }
  }

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    await Promise.all(batch.map(handle))
    if (i + batchSize < targets.length) await sleep(pauseMs)
  }

  deps.log?.info?.({ stats }, 'purchase-message job complete')
  return stats
}
