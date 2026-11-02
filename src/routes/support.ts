import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { createTicket, MAX_TICKET_BODY } from '../support/service.js'

function mapMessage(m: any) {
  return { id: m.id, sender: m.sender, body: m.body, createdAt: m.created_at }
}

export async function supportRoutes(app: FastifyInstance) {
  // List my tickets, newest activity first, with a preview + unread flag.
  app.get('/support/tickets', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    let tickets: any[]
    try {
      tickets = await sql`
        select id, status, last_sender, last_message_at, created_at
        from support_tickets
        where user_id = ${req.userId}
        order by last_message_at desc`
    } catch {
      return reply.status(500).send({ error: 'tickets_fetch_failed' })
    }

    const ids = (tickets ?? []).map((t: any) => t.id)
    const previews: Record<string, string> = {}
    const unread = new Set<string>()
    if (ids.length) {
      // Opening message per ticket (earliest) → preview.
      // Previews/unread are best-effort: a failed lookup just leaves them blank.
      const firsts = await sql`
        select ticket_id, body, created_at from support_messages
        where ticket_id = any(${ids}::uuid[])
        order by created_at asc`.catch(() => [])
      for (const m of firsts) if (!(m.ticket_id in previews)) previews[m.ticket_id] = m.body
      // Tickets with an unread admin message.
      const unreadRows = await sql`
        select ticket_id from support_messages
        where ticket_id = any(${ids}::uuid[]) and sender = 'admin' and read_by_user_at is null`
        .catch(() => [])
      for (const m of unreadRows) unread.add(m.ticket_id)
    }

    return {
      tickets: (tickets ?? []).map((t: any) => ({
        id: t.id,
        status: t.status,
        lastSender: t.last_sender,
        lastMessageAt: t.last_message_at,
        createdAt: t.created_at,
        preview: (previews[t.id] ?? '').slice(0, 120),
        unread: unread.has(t.id),
      })),
    }
  })

  // One ticket + its thread. Marks admin messages read as a side effect.
  app.get('/support/tickets/:id', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }

    // Malformed id can't be a ticket — 404 instead of a Postgres cast error.
    const [ticket] = isUuid(id)
      ? await sql`
          select id, status, created_at from support_tickets
          where id = ${id} and user_id = ${req.userId}`.catch(() => [])
      : []
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    let messages: any[]
    try {
      messages = await sql`
        select id, sender, body, created_at from support_messages
        where ticket_id = ${id}
        order by created_at asc`
    } catch {
      return reply.status(500).send({ error: 'messages_fetch_failed' })
    }

    // Read-receipt side effect is best-effort (its error was ignored before).
    await sql`
      update support_messages set read_by_user_at = ${new Date().toISOString()}
      where ticket_id = ${id} and sender = 'admin' and read_by_user_at is null`
      .catch((err) => req.log.warn({ err }, 'support read-receipt update failed'))

    return {
      ticket: { id: ticket.id, status: ticket.status, createdAt: ticket.created_at },
      messages: (messages ?? []).map(mapMessage),
    }
  })

  app.post('/support/tickets', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = typeof body.body === 'string' ? body.body : ''

    const result = await createTicket(req.userId, text)
    if (!result.ok) {
      const status = result.error === 'too_many_open_tickets' ? 429
        : result.error === 'create_failed' ? 500 : 400
      return reply.status(status).send({ error: result.error })
    }
    return { ticket: { id: result.ticketId, status: 'open', createdAt: result.createdAt } }
  })

  app.post('/support/tickets/:id/messages', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = (typeof body.body === 'string' ? body.body : '').trim()
    if (!text) return reply.status(400).send({ error: 'empty_body' })
    if (text.length > MAX_TICKET_BODY) return reply.status(400).send({ error: 'body_too_long' })

    const [ticket] = isUuid(id)
      ? await sql`select id from support_tickets where id = ${id} and user_id = ${req.userId}`.catch(() => [])
      : []
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    let message: any
    try {
      ;[message] = await sql`
        insert into support_messages (ticket_id, sender, body) values (${id}, 'user', ${text})
        returning id, sender, body, created_at`
    } catch {
      return reply.status(500).send({ error: 'send_failed' })
    }
    if (!message) return reply.status(500).send({ error: 'send_failed' })

    // A user reply reopens a closed ticket and flips the queue back to us.
    try {
      await sql`
        update support_tickets
        set status = 'open', last_sender = 'user', last_message_at = ${new Date().toISOString()}
        where id = ${id}`
    } catch {
      return reply.status(500).send({ error: 'reopen_failed' })
    }

    return { message: mapMessage(message) }
  })
}
