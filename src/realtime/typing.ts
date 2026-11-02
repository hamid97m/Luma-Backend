import { sql } from '../db.js'

/**
 * "Typing…" signal. Ephemeral — never stored. POST /matches/:id/typing publishes
 * `pg_notify('luma_typing', {matchId, from, to})`; every process LISTENs (see
 * listener.ts) and its hub writes `event: typing` to `to`'s local streams, if any.
 */

export const TYPING_CHANNEL = 'luma_typing'

export interface TypingNotify {
  matchId: string
  /** The user who is typing. */
  from: string
  /** The counterpart — the only recipient. */
  to: string
}

/** Parse a `luma_typing` payload; null when malformed. */
export function parseTypingNotify(payload: string): TypingNotify | null {
  try {
    const p = JSON.parse(payload)
    if (!p) return null
    for (const k of ['matchId', 'from', 'to']) if (typeof p[k] !== 'string') return null
    return { matchId: p.matchId, from: p.from, to: p.to }
  } catch {
    return null
  }
}

export async function publishTyping(n: TypingNotify): Promise<void> {
  await sql`select pg_notify(${TYPING_CHANNEL}, ${JSON.stringify(n)})`
}

const TTL_MS = 60_000
const MAX_ENTRIES = 10_000

/**
 * (matchId, userId) → counterpart userId for a match that was usable a moment
 * ago, so a typing ping every few seconds doesn't re-run the match lookup.
 * Only positive results are stored; a block/delete takes effect within the TTL.
 * Bounded: past `max` entries the oldest is dropped.
 */
export function createTypingTargetCache(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? TTL_MS
  const max = opts.max ?? MAX_ENTRIES
  const now = opts.now ?? Date.now
  const entries = new Map<string, { to: string; expires: number }>()
  const key = (matchId: string, userId: string) => `${matchId}:${userId}`

  return {
    get(matchId: string, userId: string): string | null {
      const k = key(matchId, userId)
      const e = entries.get(k)
      if (!e) return null
      if (e.expires <= now()) {
        entries.delete(k)
        return null
      }
      return e.to
    },
    set(matchId: string, userId: string, to: string): void {
      const k = key(matchId, userId)
      entries.delete(k) // re-insert at the end (newest)
      entries.set(k, { to, expires: now() + ttlMs })
      while (entries.size > max) entries.delete(entries.keys().next().value as string)
    },
    clear(): void {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

export type TypingTargetCache = ReturnType<typeof createTypingTargetCache>

/** The process-wide cache used by POST /matches/:id/typing. */
export const typingTargets = createTypingTargetCache()
