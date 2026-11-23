import { createHash } from 'node:crypto'

/** Rollout share of women who see "Ask a friend": ASK_FRIEND_PERCENT (0-100).
 *  Unset → 0 in production (off until switched on), 100 elsewhere (dev/tests). */
export function askFriendPercent(): number {
  const raw = process.env.ASK_FRIEND_PERCENT
  if (raw === undefined || raw.trim() === '') return process.env.NODE_ENV === 'production' ? 0 : 100
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.floor(n)))
}

/** Stable 0-99 bucket per user, so a user stays in (or out of) the rollout. */
export function rolloutBucket(userId: string): number {
  return createHash('sha256').update(userId).digest().readUInt32BE(0) % 100
}

export function inAskRollout(userId: string): boolean {
  return rolloutBucket(userId) < askFriendPercent()
}

/** Only women with a finished profile can ask. */
export function canUseAskFriend(u: { id: string; gender: string; age: number }): boolean {
  return u.gender === 'woman' && u.age > 0 && inAskRollout(u.id)
}

export const ASK_TTL_MS = 48 * 60 * 60 * 1000
export const ASK_MAX_RECIPIENTS = 3
export const ASK_MAX_OPEN = 5
export const ASK_MAX_PER_DAY = 10
export const ASK_EDIT_WINDOW_MS = 10 * 60 * 1000
export const ASK_REMIND_AFTER_MS = 12 * 60 * 60 * 1000
export const ASK_ANSWER_NOTIFY_GAP_MS = 60 * 60 * 1000
export const ASK_NUDGE_AFTER_MS = 3 * 24 * 60 * 60 * 1000
export const ASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const ASK_NOTE_MAX = 300
