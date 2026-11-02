import { sql } from '../db.js'

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

  // A failed count reads as 0 on purpose (never blocks opening a ticket).
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from support_tickets
    where user_id = ${userId} and status = 'open'`.catch(() => [{ count: 0 }])
  if (count >= MAX_OPEN_TICKETS) return { ok: false, error: 'too_many_open_tickets' }

  const nowIso = new Date().toISOString()
  // Ticket + opening message together: a failed message insert rolls the ticket
  // back, so no message-less ticket occupies the open-ticket cap.
  let ticket: { id: string; created_at: string }
  try {
    ticket = await sql.begin(async (tx) => {
      const [t] = await tx<{ id: string; created_at: string }[]>`
        insert into support_tickets (user_id, status, last_sender, last_message_at)
        values (${userId}, 'open', 'user', ${nowIso})
        returning id, created_at`
      await tx`insert into support_messages (ticket_id, sender, body) values (${t.id}, 'user', ${body})`
      return t
    })
  } catch {
    return { ok: false, error: 'create_failed' }
  }

  return { ok: true, ticketId: ticket.id, createdAt: ticket.created_at }
}
