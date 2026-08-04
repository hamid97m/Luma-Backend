import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { createTicket, MAX_TICKET_BODY } from '../support/service.js'

function mapMessage(m: any) {
  return { id: m.id, sender: m.sender, body: m.body, createdAt: m.created_at }
}

export async function supportRoutes(app: FastifyInstance) {
  // List my tickets, newest activity first, with a preview + unread flag.
  app.get('/support/tickets', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { data: tickets, error } = await db
      .from('support_tickets')
      .select('id, status, last_sender, last_message_at, created_at')
      .eq('user_id', req.userId)
      .order('last_message_at', { ascending: false })
    if (error) return reply.status(500).send({ error: 'tickets_fetch_failed' })

    const ids = (tickets ?? []).map((t: any) => t.id)
    const previews: Record<string, string> = {}
    const unread = new Set<string>()
    if (ids.length) {
      // Opening message per ticket (earliest) → preview.
      const { data: firsts } = await db
        .from('support_messages')
        .select('ticket_id, body, created_at')
        .in('ticket_id', ids)
        .order('created_at', { ascending: true })
      for (const m of firsts ?? []) if (!(m.ticket_id in previews)) previews[m.ticket_id] = m.body
      // Tickets with an unread admin message.
      const { data: unreadRows } = await db
        .from('support_messages')
        .select('ticket_id')
        .in('ticket_id', ids)
        .eq('sender', 'admin')
        .is('read_by_user_at', null)
      for (const m of unreadRows ?? []) unread.add(m.ticket_id)
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

    const { data: ticket } = await db
      .from('support_tickets')
      .select('id, status, created_at')
      .eq('id', id)
      .eq('user_id', req.userId)
      .maybeSingle()
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    const { data: messages, error } = await db
      .from('support_messages')
      .select('id, sender, body, created_at')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true })
    if (error) return reply.status(500).send({ error: 'messages_fetch_failed' })

    await db
      .from('support_messages')
      .update({ read_by_user_at: new Date().toISOString() })
      .eq('ticket_id', id)
      .eq('sender', 'admin')
      .is('read_by_user_at', null)

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

    const { data: ticket } = await db
      .from('support_tickets')
      .select('id')
      .eq('id', id)
      .eq('user_id', req.userId)
      .maybeSingle()
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    const { data: message, error } = await db
      .from('support_messages')
      .insert({ ticket_id: id, sender: 'user', body: text })
      .select('id, sender, body, created_at')
      .single()
    if (error || !message) return reply.status(500).send({ error: 'send_failed' })

    // A user reply reopens a closed ticket and flips the queue back to us.
    const { error: reopenErr } = await db
      .from('support_tickets')
      .update({ status: 'open', last_sender: 'user', last_message_at: new Date().toISOString() })
      .eq('id', id)
    if (reopenErr) return reply.status(500).send({ error: 'reopen_failed' })

    return { message: mapMessage(message) }
  })
}
