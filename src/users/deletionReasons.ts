import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db.js'

/** Answers offered on the delete-account screen (the frontend sends these codes). */
export const DELETION_REASONS = [
  'found_someone', 'few_matches', 'no_replies', 'fake_profiles', 'too_expensive',
  'privacy_safety', 'buggy', 'taking_break', 'other',
] as const

export const NOTE_MAX_LENGTH = 500

/** Lenient read of the optional `{ reason, note }` body: anything unexpected
 *  becomes null, never an error. */
export function parseDeletionReason(body: unknown): { reason: string | null; note: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as { reason?: unknown; note?: unknown }
  const reason = typeof b.reason === 'string' && (DELETION_REASONS as readonly string[]).includes(b.reason)
    ? b.reason
    : null
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, NOTE_MAX_LENGTH) || null : null
  return { reason, note }
}

/** Records one deletion (answered or skipped) with a snapshot of the user
 *  (gender, premium, account age). Never throws: a failed insert
 *  must not block the delete. */
export async function recordDeletionReason(userId: string, body: unknown, log: FastifyBaseLogger): Promise<void> {
  const { reason, note } = parseDeletionReason(body)
  try {
    await sql`
      insert into account_deletion_reasons (user_id, reason, note, gender, was_premium, days_since_signup)
      select id, ${reason}, ${note}, gender,
             coalesce(premium_until > now(), false),
             floor(extract(epoch from (now() - created_at)) / 86400)::int
      from users where id = ${userId}`
  } catch (err) {
    log.error({ err, userId }, 'deletion reason insert failed')
  }
}
