import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
import { pickFakeSender, type FakeChatUser } from '../../messaging/fakeParticipant.js'
import { deliverMessageNotification } from '../../messaging/deliver.js'

const PAGE_SIZE = 20
const MESSAGES_PAGE_SIZE = 50

// Participant columns, flattened per side (u1_* / u2_*) and rebuilt into the
// `user1` / `user2` objects the old embedded select returned. Built in JS (not
// json_build_object) so timestamps keep the ISO format of the type parser.
const USER_COLS = ['id', 'name', 'is_seed', 'telegram_id', 'last_active', 'notified_offline_at', 'allows_write_to_pm'] as const

const participantCols = (alias: 'u1' | 'u2') => sql.unsafe(
  USER_COLS.map((c) => `${alias}.${c} as ${alias}_${c}`).join(', ') +
  `, coalesce((select json_agg(json_build_object('url', p.url, 'position', p.position))
              from user_photos p where p.user_id = ${alias}.id), '[]') as ${alias}_user_photos`,
)

function nestUser(row: any, alias: 'u1' | 'u2') {
  if (row[`${alias}_id`] == null) return null // left join miss → null
  const u: Record<string, unknown> = {}
  for (const c of USER_COLS) u[c] = row[`${alias}_${c}`]
  u.user_photos = row[`${alias}_user_photos`] ?? []
  return u
}

/** Matches with both participants nested as `user1` / `user2` (old MATCH_SELECT shape). */
function withParticipants(rows: any[]) {
  return rows.map((row) => ({
    id: row.id, created_at: row.created_at, last_message_at: row.last_message_at,
    user1_id: row.user1_id, user2_id: row.user2_id,
    user1: nestUser(row, 'u1'), user2: nestUser(row, 'u2'),
    message_count: row.message_count, last_body: row.last_body, last_created_at: row.last_created_at,
    has_last: row.has_last,
  }))
}

async function findMatch(matchId: string) {
  const rows = await sql`
    select m.id, m.created_at, m.last_message_at, m.user1_id, m.user2_id,
           ${participantCols('u1')}, ${participantCols('u2')}
    from matches m
    left join users u1 on u1.id = m.user1_id
    left join users u2 on u2.id = m.user2_id
    where m.id = ${matchId}`
  return withParticipants(rows)[0]
}

/** One page of chat-list rows (newest activity first), each with its non-icebreaker
 *  message count and latest non-icebreaker message. `ids` restricts the set. */
async function chatListRows(from: number, ids?: string[]) {
  const rows = await sql`
    select m.id, m.created_at, m.last_message_at, m.user1_id, m.user2_id,
           ${participantCols('u1')}, ${participantCols('u2')},
           (select count(*)::int from messages c where c.match_id = m.id and c.type <> 'icebreaker') as message_count,
           last.body as last_body, last.created_at as last_created_at, last.found as has_last
    from matches m
    left join users u1 on u1.id = m.user1_id
    left join users u2 on u2.id = m.user2_id
    left join lateral (
      select l.body, l.created_at, true as found from messages l
      where l.match_id = m.id and l.type <> 'icebreaker'
      order by l.created_at desc limit 1
    ) last on true
    ${ids ? sql`where m.id = any(${ids}::uuid[])` : sql``}
    order by m.last_message_at desc
    limit ${PAGE_SIZE} offset ${from}`
  return withParticipants(rows).map((row) => ({
    matchId: row.id,
    matchedAt: row.created_at,
    users: [participant(row.user1), participant(row.user2)],
    messageCount: row.message_count ?? 0,
    lastMessage: row.has_last ? { body: row.last_body, createdAt: row.last_created_at } : null,
  }))
}

function participant(u: any) {
  const photo =
    (u?.user_photos ?? []).slice().sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
  return { id: u?.id ?? null, name: u?.name ?? '', photo, isSeed: !!u?.is_seed }
}

function fakeChatUser(u: any): FakeChatUser {
  return {
    id: u?.id, name: u?.name ?? '', is_seed: !!u?.is_seed,
    telegram_id: u?.telegram_id ?? null, last_active: u?.last_active ?? null,
    notified_offline_at: u?.notified_offline_at ?? null, allows_write_to_pm: u?.allows_write_to_pm ?? null,
  }
}

// Match ids where a fake chat (exactly one seed participant) has ≥1 unread,
// non-icebreaker message from the real user. Reused by GET /chats/unread-count
// and the ?filter=fake-unread list. Errors yield [] — the old version ignored them.
async function fakeUnreadMatchIds(): Promise<string[]> {
  try {
    const rows = await sql<{ id: string }[]>`
      select distinct m.id
      from matches m
      join users u1 on u1.id = m.user1_id
      join users u2 on u2.id = m.user2_id
      join messages msg on msg.match_id = m.id
      where u1.is_seed <> u2.is_seed
        and msg.read_at is null
        and msg.type <> 'icebreaker'
        and msg.sender_id = case when u1.is_seed then m.user2_id else m.user1_id end`
    return rows.map((r) => r.id)
  } catch (err) {
    console.error('[admin] fake-unread lookup failed:', (err as Error)?.message ?? err)
    return []
  }
}

export async function adminChatsRoutes(app: FastifyInstance) {
  app.get('/chats/unread-count', async () => {
    const ids = await fakeUnreadMatchIds()
    return { count: ids.length }
  })

  app.get('/chats', async (req, reply) => {
    const { page = '1', filter } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    if (filter === 'fake-unread') {
      const unreadIds = await fakeUnreadMatchIds()
      const total = unreadIds.length
      if (total === 0) return { items: [], total: 0, page: pageNum, pageCount: 1 }
      let items
      try {
        items = await chatListRows(from, unreadIds)
      } catch (err) {
        req.log.error({ err }, 'chats fetch failed')
        return reply.status(500).send({ error: 'chats_fetch_failed' })
      }
      return { items, total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
    }

    let items
    let total: number
    try {
      const [rows, [{ count }]] = await Promise.all([
        chatListRows(from),
        sql<{ count: number }[]>`select count(*)::int as count from matches`,
      ])
      items = rows
      total = count
    } catch (err) {
      req.log.error({ err }, 'chats fetch failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }

    return { items, total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
  })

  app.get('/chats/:matchId', async (req, reply) => {
    const { matchId } = req.params as { matchId: string }
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * MESSAGES_PAGE_SIZE

    let match: any
    try {
      match = isUuid(matchId) ? await findMatch(matchId) : undefined
    } catch (err) {
      req.log.error({ err }, 'match lookup failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    // If this is a fake chat, opening it "reads" the real user's messages so
    // the unread badge clears. Never do this for real↔real chats (would forge
    // read-receipts between two real users).
    const picked = pickFakeSender(fakeChatUser((match as any).user1), fakeChatUser((match as any).user2))
    if (picked) {
      try {
        await sql`
          update messages set read_at = ${new Date().toISOString()}
          where match_id = ${matchId} and sender_id = ${picked.recipient.id} and read_at is null`
      } catch (err) {
        req.log.warn({ err }, 'marking fake-chat messages read failed') // ignored before, too
      }
    }

    let rows: any[]
    let total: number
    try {
      const [msgRows, [{ count }]] = await Promise.all([
        sql`
          select id, sender_id, body, created_at, read_at, type, icebreaker_answer
          from messages where match_id = ${matchId}
          order by created_at asc
          limit ${MESSAGES_PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from messages where match_id = ${matchId}`,
      ])
      rows = msgRows
      total = count
    } catch (err) {
      req.log.error({ err }, 'messages fetch failed')
      return reply.status(500).send({ error: 'messages_fetch_failed' })
    }

    return {
      match: {
        id: (match as any).id,
        matchedAt: (match as any).created_at,
        users: [participant((match as any).user1), participant((match as any).user2)],
      },
      messages: {
        items: (rows ?? []).map((m: any) => ({
          id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at, readAt: m.read_at,
          type: m.type, icebreakerAnswer: m.icebreaker_answer ?? null,
        })),
        total,
        page: pageNum,
        pageCount: Math.max(1, Math.ceil(total / MESSAGES_PAGE_SIZE)),
      },
    }
  })

  app.post('/chats/:matchId/messages', async (req, reply) => {
    const { matchId } = req.params as { matchId: string }
    const { body } = req.body as { body?: string }
    const trimmed = (body ?? '').trim()
    if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
    if (trimmed.length > 2000) return reply.status(400).send({ error: 'message_too_long' })

    let match: any
    try {
      match = isUuid(matchId) ? await findMatch(matchId) : undefined
    } catch (err) {
      req.log.error({ err }, 'match lookup failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const picked = pickFakeSender(fakeChatUser((match as any).user1), fakeChatUser((match as any).user2))
    if (!picked) return reply.status(400).send({ error: 'no_fake_participant' })

    let message: { id: string; sender_id: string; body: string; created_at: string } | undefined
    try {
      ;[message] = await sql<{ id: string; sender_id: string; body: string; created_at: string }[]>`
        insert into messages (match_id, sender_id, body, type)
        values (${matchId}, ${picked.fake.id}, ${trimmed}, 'text')
        returning id, sender_id, body, created_at`
    } catch (err) {
      req.log.error({ err }, 'admin fake send failed')
    }
    if (!message) return reply.status(500).send({ error: 'send_failed' })

    void deliverMessageNotification(
      {
        id: picked.recipient.id, telegram_id: picked.recipient.telegram_id,
        last_active: picked.recipient.last_active, notified_offline_at: picked.recipient.notified_offline_at,
        allows_write_to_pm: picked.recipient.allows_write_to_pm,
      },
      picked.fake.id, picked.fake.name, trimmed, matchId, req.log,
    )

    return { message: { id: message.id, senderId: message.sender_id, body: message.body, createdAt: message.created_at, readAt: null } }
  })
}
