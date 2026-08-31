import { db } from '../db.js'
import { isPremiumEnabled, isPremiumActive } from './service.js'
import { swipeLimitApplies } from './swipeLimit.js'

// A free man seeking women may chat with FREE_CHAT_LIMIT distinct people for
// free; a "chat" is counted the first time he SENDS a message in a match.
// Continuing any conversation he's already messaged in stays free forever —
// only *starting* a new one beyond the limit requires premium. Women, everyone
// outside the cohort, premium members, and everyone while the premium toggle
// is off are unlimited. Reading is never gated (this only guards sending).
export const FREE_CHAT_LIMIT = 3

// Reuse the swipe-limit cohort so the two free-tier gates stay in lockstep.
// Wrapped (not re-exported) so this module doesn't touch swipeLimitApplies at
// load time — suites that partially mock swipeLimit.js would otherwise crash on
// import via the server's route graph.
export function chatLimitApplies(gender: string | null, lookingFor: string | null): boolean {
  return swipeLimitApplies(gender, lookingFor)
}

export interface ChatGateContext {
  /** True only when the viewer is in the limited cohort right now. */
  gated: boolean
  /** Distinct matches the viewer has already sent at least one message in. */
  chattedMatchIds: Set<string>
}

/**
 * Whether sending in `matchId` is blocked behind premium. Pure so it can back
 * both the per-match `premiumRequired` flag (matches list) and the send gate.
 * Blocked only when the viewer is gated, hasn't messaged in this match yet, and
 * has already used up all free chat slots.
 */
export function matchPremiumRequired(
  ctx: ChatGateContext,
  matchId: string,
  limit = FREE_CHAT_LIMIT,
): boolean {
  if (!ctx.gated) return false
  if (ctx.chattedMatchIds.has(matchId)) return false
  return ctx.chattedMatchIds.size >= limit
}

const COHORT_COLUMNS = 'gender, looking_for, premium_until'

/** Cheap cohort/premium check; db-error and every exempt case fail open. */
async function isGated(userId: string, nowMs: number): Promise<boolean> {
  const { data: me, error } = await db.from('users').select(COHORT_COLUMNS).eq('id', userId).single()
  if (error || !me) return false
  if (!chatLimitApplies(me.gender ?? null, me.looking_for ?? null)) return false
  if (!(await isPremiumEnabled())) return false
  if (isPremiumActive(me.premium_until ?? null, nowMs)) return false
  return true
}

/** Distinct match ids the user has sent a message in (deduped in memory). */
async function distinctChattedMatchIds(userId: string): Promise<Set<string>> {
  const { data } = await db.from('messages').select('match_id').eq('sender_id', userId)
  return new Set((data ?? []).map((r: { match_id: string }) => r.match_id))
}

/**
 * Build the gate context for a viewer once — used by the matches list so the
 * per-match flag costs a single messages read, not one per row. Non-gated
 * viewers get an empty context (every match is free).
 */
export async function chatGateContext(userId: string, nowMs = Date.now()): Promise<ChatGateContext> {
  if (!(await isGated(userId, nowMs))) return { gated: false, chattedMatchIds: new Set() }
  return { gated: true, chattedMatchIds: await distinctChattedMatchIds(userId) }
}

/** Send-time gate for POST /matches/:id/messages. True → return 403 premium_required. */
export async function chatSendBlocked(userId: string, matchId: string, nowMs = Date.now()): Promise<boolean> {
  const ctx = await chatGateContext(userId, nowMs)
  return matchPremiumRequired(ctx, matchId)
}
