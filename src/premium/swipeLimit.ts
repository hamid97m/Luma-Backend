import { db } from '../db.js'
import { isPremiumEnabled, isPremiumActive } from './service.js'

// Free men seeking women get SWIPE_LIMIT swipes (likes AND passes) per
// 4-hour window; the window starts at their first counted swipe and fully
// refills when it ends. Everyone else — and premium members, and everyone
// while the premium toggle is off — is unlimited.
export const SWIPE_LIMIT = 20
export const SWIPE_WINDOW_MS = 4 * 60 * 60 * 1000

export function swipeLimitApplies(gender: string | null, lookingFor: string | null): boolean {
  return gender === 'man' && ['women', 'both', 'everyone'].includes(lookingFor ?? '')
}

export interface SwipeWindow {
  blocked: boolean
  resetAt: string
  /** Present when not blocked: window fields to persist for this swipe. */
  nextStartedAt?: string
  nextCount?: number
  remaining?: number
}

export function evaluateSwipeWindow(startedAt: string | null, count: number, nowMs = Date.now()): SwipeWindow {
  const startMs = startedAt ? new Date(startedAt).getTime() : 0
  if (!startedAt || nowMs >= startMs + SWIPE_WINDOW_MS) {
    return {
      blocked: false,
      resetAt: new Date(nowMs + SWIPE_WINDOW_MS).toISOString(),
      nextStartedAt: new Date(nowMs).toISOString(),
      nextCount: 1,
      remaining: SWIPE_LIMIT - 1,
    }
  }
  const resetAt = new Date(startMs + SWIPE_WINDOW_MS).toISOString()
  if (count >= SWIPE_LIMIT) return { blocked: true, resetAt }
  return { blocked: false, resetAt, nextStartedAt: startedAt, nextCount: count + 1, remaining: SWIPE_LIMIT - (count + 1) }
}

const WINDOW_COLUMNS = 'gender, looking_for, premium_until, swipe_window_started_at, swipe_window_count'

async function loadLimitedUser(userId: string, nowMs: number) {
  const { data: me, error } = await db.from('users').select(WINDOW_COLUMNS).eq('id', userId).single()
  // Order mirrors premiumGateBlocks: cheap cohort check first, db-error fails open.
  if (error || !me) return null
  if (!swipeLimitApplies(me.gender ?? null, me.looking_for ?? null)) return null
  if (!(await isPremiumEnabled())) return null
  if (isPremiumActive(me.premium_until ?? null, nowMs)) return null
  return me
}

export type SwipeLimitCheck =
  | { blocked: true; resetAt: string }
  | { blocked: false; swipeLimit: { remaining: number; resetAt: string } | null }

/** Gate + counter for POST /swipes: blocks at the limit, otherwise counts this swipe. */
export async function checkAndCountSwipe(userId: string, nowMs = Date.now()): Promise<SwipeLimitCheck> {
  const me = await loadLimitedUser(userId, nowMs)
  if (!me) return { blocked: false, swipeLimit: null }

  const w = evaluateSwipeWindow(me.swipe_window_started_at ?? null, me.swipe_window_count ?? 0, nowMs)
  if (w.blocked) return { blocked: true, resetAt: w.resetAt }

  const { error } = await db
    .from('users')
    .update({ swipe_window_started_at: w.nextStartedAt, swipe_window_count: w.nextCount })
    .eq('id', userId)
  // Couldn't persist the counter — fail open without limit info rather than
  // showing the user a countdown we didn't actually record.
  if (error) return { blocked: false, swipeLimit: null }
  return { blocked: false, swipeLimit: { remaining: w.remaining!, resetAt: w.resetAt } }
}

/** Read-only status for GET /discovery (never counts). */
export async function getSwipeLimitStatus(userId: string, nowMs = Date.now()): Promise<{ limited: boolean; resetAt: string | null }> {
  const me = await loadLimitedUser(userId, nowMs)
  if (!me) return { limited: false, resetAt: null }
  const w = evaluateSwipeWindow(me.swipe_window_started_at ?? null, me.swipe_window_count ?? 0, nowMs)
  return w.blocked ? { limited: true, resetAt: w.resetAt } : { limited: false, resetAt: null }
}
