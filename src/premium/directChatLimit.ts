import { db } from '../db.js'
import { isPremiumEnabled, isPremiumActive } from './service.js'
import { swipeLimitApplies } from './swipeLimit.js'

// Premium men seeking women may START up to DIRECT_CHAT_LIMIT direct chats
// (chatting without a mutual like) per rolling window. Women, everyone outside
// the cohort, and everyone while premium is off chat freely & unlimited;
// non-premium men in the cohort are routed to the paywall instead.
export const DIRECT_CHAT_LIMIT = 3
export const DIRECT_CHAT_WINDOW_MS = 24 * 60 * 60 * 1000

// Reuse the swipe cohort so the free-tier gates stay in lockstep.
export function directChatLimitApplies(gender: string | null, lookingFor: string | null): boolean {
  return swipeLimitApplies(gender, lookingFor)
}

export interface DirectChatWindow {
  blocked: boolean
  resetAt: string
  nextStartedAt?: string
  nextCount?: number
  remaining?: number
}

export function evaluateDirectChatWindow(startedAt: string | null, count: number, nowMs = Date.now()): DirectChatWindow {
  const startMs = startedAt ? new Date(startedAt).getTime() : 0
  if (!startedAt || nowMs >= startMs + DIRECT_CHAT_WINDOW_MS) {
    return {
      blocked: false,
      resetAt: new Date(nowMs + DIRECT_CHAT_WINDOW_MS).toISOString(),
      nextStartedAt: new Date(nowMs).toISOString(),
      nextCount: 1,
      remaining: DIRECT_CHAT_LIMIT - 1,
    }
  }
  const resetAt = new Date(startMs + DIRECT_CHAT_WINDOW_MS).toISOString()
  if (count >= DIRECT_CHAT_LIMIT) return { blocked: true, resetAt }
  return { blocked: false, resetAt, nextStartedAt: startedAt, nextCount: count + 1, remaining: DIRECT_CHAT_LIMIT - (count + 1) }
}

const WINDOW_COLUMNS = 'gender, looking_for, premium_until, direct_chat_window_started_at, direct_chat_window_count'

export type DirectChatGate = 'free' | 'paywall' | 'quota'

// 'free' = no gate (women / non-cohort / premium-off). 'paywall' = cohort man,
// premium on, not subscribed. 'quota' = cohort man, premium on, subscribed.
async function classifyGate(
  row: { gender: string | null; looking_for: string | null; premium_until: string | null },
  nowMs: number,
): Promise<DirectChatGate> {
  if (!directChatLimitApplies(row.gender ?? null, row.looking_for ?? null)) return 'free'
  if (!(await isPremiumEnabled())) return 'free'
  if (!isPremiumActive(row.premium_until ?? null, nowMs)) return 'paywall'
  return 'quota'
}

export interface DirectChatStatus {
  gate: DirectChatGate
  remaining: number
  limit: number
  resetAt: string | null
}

/** Read-only status for GET /discovery. Never consumes a slot. */
export async function getDirectChatStatus(userId: string, nowMs = Date.now()): Promise<DirectChatStatus> {
  const free: DirectChatStatus = { gate: 'free', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null }
  const { data: me, error } = await db.from('users').select(WINDOW_COLUMNS).eq('id', userId).single()
  if (error || !me) return free // fail open
  const gate = await classifyGate(me, nowMs)
  if (gate !== 'quota') return { ...free, gate }

  const started: string | null = me.direct_chat_window_started_at ?? null
  const count: number = me.direct_chat_window_count ?? 0
  const startMs = started ? new Date(started).getTime() : 0
  if (!started || nowMs >= startMs + DIRECT_CHAT_WINDOW_MS) {
    return { gate, remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null }
  }
  return {
    gate,
    remaining: Math.max(0, DIRECT_CHAT_LIMIT - count),
    limit: DIRECT_CHAT_LIMIT,
    resetAt: new Date(startMs + DIRECT_CHAT_WINDOW_MS).toISOString(),
  }
}

export type DirectChatCheck =
  | { gate: 'free' }
  | { gate: 'paywall' }
  | { gate: 'quota'; blocked: true; resetAt: string }
  | { gate: 'quota'; blocked: false; remaining: number; resetAt: string }

/** Optimistic-concurrency write — mirrors swipeLimit.guardedWindowUpdate. */
async function guardedWindowUpdate(userId: string, expectedCount: number, w: DirectChatWindow): Promise<'ok' | 'lost' | 'dbError'> {
  const { data, error } = await db
    .from('users')
    .update({ direct_chat_window_started_at: w.nextStartedAt, direct_chat_window_count: w.nextCount })
    .eq('id', userId)
    .eq('direct_chat_window_count', expectedCount)
    .select('id')
  if (error) return 'dbError'
  if (!data || data.length === 0) return 'lost'
  return 'ok'
}

/** Gate + counter for POST /discovery/direct-chat. Consumes a slot only for gate 'quota'. */
export async function checkAndCountDirectChat(userId: string, nowMs = Date.now()): Promise<DirectChatCheck> {
  const { data: me, error } = await db.from('users').select(WINDOW_COLUMNS).eq('id', userId).single()
  if (error || !me) return { gate: 'free' } // fail open
  const gate = await classifyGate(me, nowMs)
  if (gate === 'free') return { gate: 'free' }
  if (gate === 'paywall') return { gate: 'paywall' }

  const w = evaluateDirectChatWindow(me.direct_chat_window_started_at ?? null, me.direct_chat_window_count ?? 0, nowMs)
  if (w.blocked) return { gate: 'quota', blocked: true, resetAt: w.resetAt }

  const first = await guardedWindowUpdate(userId, me.direct_chat_window_count ?? 0, w)
  if (first !== 'lost') return { gate: 'quota', blocked: false, remaining: w.remaining!, resetAt: w.resetAt } // ok or dbError → allow

  // Lost the optimistic race — re-read once and re-evaluate.
  const { data: retry, error: retryErr } = await db.from('users').select(WINDOW_COLUMNS).eq('id', userId).single()
  if (retryErr || !retry) return { gate: 'quota', blocked: false, remaining: w.remaining!, resetAt: w.resetAt }
  const retryW = evaluateDirectChatWindow(retry.direct_chat_window_started_at ?? null, retry.direct_chat_window_count ?? 0, nowMs)
  if (retryW.blocked) return { gate: 'quota', blocked: true, resetAt: retryW.resetAt }
  await guardedWindowUpdate(userId, retry.direct_chat_window_count ?? 0, retryW)
  // Whether the second write won or lost, allow (fail-open) — the match will still be created.
  return { gate: 'quota', blocked: false, remaining: retryW.remaining!, resetAt: retryW.resetAt }
}
