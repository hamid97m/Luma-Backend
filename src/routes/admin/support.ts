import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { notifyTicketReply } from '../../bot.js'

const PAGE_SIZE = 20
const MAX_BODY = 2000

function primaryPhoto(u: any): string | null {
  return (u?.user_photos ?? []).slice().sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
}

function mapMessage(m: any) {
  return { id: m.id, sender: m.sender, body: m.body, createdAt: m.created_at }
}

export async function adminSupportRoutes(app: FastifyInstance) {
  app.get('/support/tickets', async (req, reply) => {
    const { status = 'open', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    let q = db
      .from('support_tickets')
      .select(
        'id, status, last_sender, last_message_at, created_at, ' +
        'user:users!support_tickets_user_id_fkey(id, name, user_photos(url, position))',
        { count: 'exact' },
      )
    if (status === 'open') q = q.eq('status', 'open')
    else if (status === 'closed') q = q.eq('status', 'closed')
    else if (status === 'needs_reply') q = q.eq('status', 'open').eq('last_sender', 'user')
    // 'all' → no status filter.

    const { data: rows, count, error } = await q
      .order('last_sender', { ascending: true })       // 'user' (needs reply) before 'admin'
      .order('last_message_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'tickets_fetch_failed' })

    const ids = (rows ?? []).map((r: any) => r.id)
    const previews: Record<string, string> = {}
    if (ids.length) {
      const { data: firsts } = await db
        .from('support_messages')
        .select('ticket_id, body, created_at')
        .in('ticket_id', ids)
        .order('created_at', { ascending: true })
      for (const m of firsts ?? []) if (!(m.ticket_id in previews)) previews[m.ticket_id] = m.body
    }

    const total = count ?? 0
    return {
      items: (rows ?? []).map((r: any) => ({
        id: r.id,
        user: { id: r.user?.id ?? null, name: r.user?.name ?? '', photo: primaryPhoto(r.user) },
        status: r.status,
        lastSender: r.last_sender,
        lastMessageAt: r.last_message_at,
        createdAt: r.created_at,
        preview: (previews[r.id] ?? '').slice(0, 120),
        needsReply: r.status === 'open' && r.last_sender === 'user',
      })),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })

  app.get('/support/tickets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { data: ticket } = await db
      .from('support_tickets')
      .select(
        'id, status, created_at, closed_at, ' +
        'user:users!support_tickets_user_id_fkey(id, name, telegram_id, user_photos(url, position))',
      )
      .eq('id', id)
      .maybeSingle()
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    const { data: messages, error } = await db
      .from('support_messages')
      .select('id, sender, body, created_at')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true })
    if (error) return reply.status(500).send({ error: 'messages_fetch_failed' })

    const t: any = ticket
    const u: any = t.user
    return {
      ticket: {
        id: t.id, status: t.status, createdAt: t.created_at, closedAt: t.closed_at,
        user: { id: u?.id ?? null, name: u?.name ?? '', photo: primaryPhoto(u), telegramId: u?.telegram_id ?? null },
      },
      messages: (messages ?? []).map(mapMessage),
    }
  })

  app.post('/support/tickets/:id/reply', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = (typeof body.body === 'string' ? body.body : '').trim()
    if (!text) return reply.status(400).send({ error: 'empty_body' })
    if (text.length > MAX_BODY) return reply.status(400).send({ error: 'body_too_long' })

    const { data: ticket } = await db
      .from('support_tickets')
      .select('id, user:users!support_tickets_user_id_fkey(telegram_id, allows_write_to_pm)')
      .eq('id', id)
      .maybeSingle()
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    const { data: message, error } = await db
      .from('support_messages')
      .insert({ ticket_id: id, sender: 'admin', admin_id: req.adminId, body: text })
      .select('id, sender, body, created_at')
      .single()
    if (error || !message) return reply.status(500).send({ error: 'reply_failed' })

    // Admin reply reopens a closed ticket and moves the queue to the user.
    await db
      .from('support_tickets')
      .update({ status: 'open', last_sender: 'admin', last_message_at: new Date().toISOString() })
      .eq('id', id)

    const u: any = (ticket as any).user
    if (u?.telegram_id && u.allows_write_to_pm !== false) {
      // Preview = the ticket's opening (earliest) message.
      const { data: first } = await db
        .from('support_messages')
        .select('body')
        .eq('ticket_id', id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      notifyTicketReply(u.telegram_id, first?.body ?? '', text)
        .catch((err) => req.log.warn({ err }, 'failed to send ticket reply notification'))
    }

    return { message: mapMessage(message) }
  })

  app.post('/support/tickets/:id/close', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { error } = await db
      .from('support_tickets')
      .update({ status: 'closed', closed_by: req.adminId, closed_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return reply.status(500).send({ error: 'close_failed' })
    return { ok: true }
  })

  app.post('/support/tickets/:id/reopen', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { error } = await db
      .from('support_tickets')
      .update({ status: 'open', closed_by: null, closed_at: null })
      .eq('id', id)
    if (error) return reply.status(500).send({ error: 'reopen_failed' })
    return { ok: true }
  })
}
