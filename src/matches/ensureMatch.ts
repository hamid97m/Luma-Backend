import { sql } from '../db.js'

export interface EnsuredMatch {
  matchId: string
  /** matches.created_at */
  matchedAt: string
  created: boolean
}

// Create (or fetch the existing) match between two users without a mutual like.
// Mirrors the acceptIntro pattern: normalized pair, 23505 = already matched.
export async function ensureMatch(a: string, b: string): Promise<EnsuredMatch | null> {
  const [u1, u2] = [a, b].sort()
  try {
    const [created] = await sql<{ id: string; created_at: string }[]>`
      insert into matches (user1_id, user2_id) values (${u1}, ${u2}) returning id, created_at`
    if (created) return { matchId: created.id, matchedAt: created.created_at, created: true }
    return null
  } catch (err) {
    if ((err as { code?: string })?.code !== '23505') return null
  }
  try {
    const [existing] = await sql<{ id: string; created_at: string }[]>`
      select id, created_at from matches where user1_id = ${u1} and user2_id = ${u2}`
    if (existing) return { matchId: existing.id, matchedAt: existing.created_at, created: false }
  } catch {
    // fall through → match_failed, as before
  }
  return null
}

/** The opener written before the match existed, as a normal text message. Call
 *  it after seedIcebreakers: those rows are stamped a few ms ahead from this
 *  clock, so a small offset keeps the opener below them. */
export async function insertOpener(matchId: string, senderId: string, body: string): Promise<void> {
  await sql`
    insert into messages (match_id, sender_id, body, created_at)
    values (${matchId}, ${senderId}, ${body}, ${new Date(Date.now() + 10).toISOString()})`
}
