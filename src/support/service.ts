import { db } from '../db.js'

export const MAX_TICKET_BODY = 2000
export const MAX_OPEN_TICKETS = 5
export const SUPPORT_CAPTURE_WINDOW_MS = 15 * 60 * 1000

export type CreateTicketResult =
  | { ok: true; ticketId: string; createdAt: string }
  | { ok: false; error: 'empty_body' | 'body_too_long' | 'too_many_open_tickets' | 'create_failed' }

// Whether a loose bot message should be captured as a new ticket.
export function shouldCaptureSupport(
  text: string | undefined,
  awaitingSince: string | null,
  nowMs: number,
): boolean {
  if (!awaitingSince) return false
  if (!text || text.startsWith('/')) return false
  if (nowMs - new Date(awaitingSince).getTime() > SUPPORT_CAPTURE_WINDOW_MS) return false
  return true
}

// Shared by the HTTP route and the bot. Enforces the body caps and the
// per-user open-ticket limit, then inserts the ticket + its opening message.
export async function createTicket(userId: string, rawBody: string): Promise<CreateTicketResult> {
  const body = (rawBody ?? '').trim()
  if (!body) return { ok: false, error: 'empty_body' }
  if (body.length > MAX_TICKET_BODY) return { ok: false, error: 'body_too_long' }

  const { count } = await db
    .from('support_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'open')
  if ((count ?? 0) >= MAX_OPEN_TICKETS) return { ok: false, error: 'too_many_open_tickets' }

  const nowIso = new Date().toISOString()
  const { data: ticket, error: tErr } = await db
    .from('support_tickets')
    .insert({ user_id: userId, status: 'open', last_sender: 'user', last_message_at: nowIso })
    .select('id, created_at')
    .single()
  if (tErr || !ticket) return { ok: false, error: 'create_failed' }

  const { error: mErr } = await db
    .from('support_messages')
    .insert({ ticket_id: ticket.id, sender: 'user', body })
  if (mErr) return { ok: false, error: 'create_failed' }

  return { ok: true, ticketId: ticket.id, createdAt: ticket.created_at }
}
