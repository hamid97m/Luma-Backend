import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

const PAGE_SIZE = 20
const MESSAGES_PAGE_SIZE = 50

const MATCH_SELECT = `
  id, created_at, user1_id, user2_id,
  user1:users!matches_user1_id_fkey(id, name, user_photos(url, position)),
  user2:users!matches_user2_id_fkey(id, name, user_photos(url, position))
`

function participant(u: any) {
  const photo =
    (u?.user_photos ?? []).slice().sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
  return { id: u?.id ?? null, name: u?.name ?? '', photo }
}

export async function adminChatsRoutes(app: FastifyInstance) {
  app.get('/chats', async (req, reply) => {
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    const { data: rows, count, error } = await db
      .from('matches')
      .select(MATCH_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'chats_fetch_failed' })

    const items = await Promise.all(
      (rows ?? []).map(async (row: any) => {
        const [{ count: messageCount }, { data: lastRows }] = await Promise.all([
          db.from('messages').select('id', { count: 'exact', head: true }).eq('match_id', row.id),
          db.from('messages').select('body, created_at').eq('match_id', row.id)
            .order('created_at', { ascending: false }).limit(1),
        ])
        const last = lastRows?.[0]
        return {
          matchId: row.id,
          matchedAt: row.created_at,
          users: [participant(row.user1), participant(row.user2)],
          messageCount: messageCount ?? 0,
          lastMessage: last ? { body: last.body, createdAt: last.created_at } : null,
        }
      })
    )

    const total = count ?? 0
    return { items, total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
  })

  app.get('/chats/:matchId', async (req, reply) => {
    const { matchId } = req.params as { matchId: string }
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * MESSAGES_PAGE_SIZE

    const { data: match } = await db
      .from('matches')
      .select(MATCH_SELECT)
      .eq('id', matchId)
      .single()

    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const { data: rows, count, error } = await db
      .from('messages')
      .select('id, sender_id, body, created_at, read_at', { count: 'exact' })
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })
      .range(from, from + MESSAGES_PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'messages_fetch_failed' })

    const total = count ?? 0
    return {
      match: {
        id: (match as any).id,
        matchedAt: (match as any).created_at,
        users: [participant((match as any).user1), participant((match as any).user2)],
      },
      messages: {
        items: (rows ?? []).map((m: any) => ({
          id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at, readAt: m.read_at,
        })),
        total,
        page: pageNum,
        pageCount: Math.max(1, Math.ceil(total / MESSAGES_PAGE_SIZE)),
      },
    }
  })
}
