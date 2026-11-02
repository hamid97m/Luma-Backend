import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
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

    const where =
      status === 'open' ? sql`where t.status = 'open'`
      : status === 'closed' ? sql`where t.status = 'closed'`
      : status === 'needs_reply' ? sql`where t.status = 'open' and t.last_sender = 'user'`
      : sql``
    // 'all' (or anything else) → no status filter.

    let rows: any[]
    let count: number
    try {
      ;[rows, [{ count }]] = await Promise.all([
        sql`
          select t.id, t.status, t.last_sender, t.last_message_at, t.created_at,
            case when u.id is null then null else json_build_object(
              'id', u.id, 'name', u.name,
              'user_photos', coalesce((
                select json_agg(json_build_object('url', p.url, 'position', p.position))
                from user_photos p where p.user_id = u.id), '[]'::json)
            ) end as user
          from support_tickets t
          left join users u on u.id = t.user_id
          ${where}
          -- msg_sender enum order: 'user' (needs reply) before 'admin'
          order by t.last_sender asc, t.last_message_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from support_tickets t ${where}`,
      ])
    } catch {
      return reply.status(500).send({ error: 'tickets_fetch_failed' })
    }

    const ids = (rows ?? []).map((r: any) => r.id)
    const previews: Record<string, string> = {}
    if (ids.length) {
      const firsts = await sql`
        select ticket_id, body, created_at from support_messages
        where ticket_id = any(${ids}::uuid[])
        order by created_at asc`.catch(() => [])
      for (const m of firsts) if (!(m.ticket_id in previews)) previews[m.ticket_id] = m.body
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
    const [ticket] = isUuid(id)
      ? await sql`
          select t.id, t.status, t.created_at, t.closed_at,
            case when u.id is null then null else json_build_object(
              'id', u.id, 'name', u.name, 'telegram_id', u.telegram_id,
              'user_photos', coalesce((
                select json_agg(json_build_object('url', p.url, 'position', p.position))
                from user_photos p where p.user_id = u.id), '[]'::json)
            ) end as user
          from support_tickets t
          left join users u on u.id = t.user_id
          where t.id = ${id}`.catch(() => [])
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

    const [ticket] = isUuid(id)
      ? await sql`
          select t.id, u.telegram_id, u.allows_write_to_pm, u.locale
          from support_tickets t
          left join users u on u.id = t.user_id
          where t.id = ${id}`.catch(() => [])
      : []
    if (!ticket) return reply.status(404).send({ error: 'ticket_not_found' })

    let message: any
    try {
      ;[message] = await sql`
        insert into support_messages (ticket_id, sender, admin_id, body)
        values (${id}, 'admin', ${req.adminId ?? null}, ${text})
        returning id, sender, body, created_at`
    } catch {
      return reply.status(500).send({ error: 'reply_failed' })
    }
    if (!message) return reply.status(500).send({ error: 'reply_failed' })

    // Admin reply reopens a closed ticket and moves the queue to the user.
    // Best-effort, as before (its error was ignored).
    await sql`
      update support_tickets
      set status = 'open', last_sender = 'admin', last_message_at = ${new Date().toISOString()}
      where id = ${id}`.catch((err) => req.log.warn({ err }, 'ticket reopen on reply failed'))

    const u: any = ticket
    if (u?.telegram_id && u.allows_write_to_pm !== false) {
      // Preview = the ticket's opening (earliest) message.
      const [first] = await sql<{ body: string }[]>`
        select body from support_messages
        where ticket_id = ${id}
        order by created_at asc
        limit 1`.catch(() => [])
      notifyTicketReply(u.telegram_id, first?.body ?? '', text, u.locale ?? null)
        .catch((err) => req.log.warn({ err }, 'failed to send ticket reply notification'))
    }

    return { message: mapMessage(message) }
  })

  app.post('/support/tickets/:id/close', async (req, reply) => {
    const { id } = req.params as { id: string }
    // A malformed id matches no ticket: a no-op update.
    if (isUuid(id)) {
      try {
        await sql`
          update support_tickets
          set status = 'closed', closed_by = coalesce(${req.adminId ?? null}::uuid, closed_by), closed_at = ${new Date().toISOString()}
          where id = ${id}`
      } catch {
        return reply.status(500).send({ error: 'close_failed' })
      }
    }
    return { ok: true }
  })

  app.post('/support/tickets/:id/reopen', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (isUuid(id)) {
      try {
        await sql`update support_tickets set status = 'open', closed_by = null, closed_at = null where id = ${id}`
      } catch {
        return reply.status(500).send({ error: 'reopen_failed' })
      }
    }
    return { ok: true }
  })
}
