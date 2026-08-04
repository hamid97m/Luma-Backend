import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

export async function matchesRoutes(app: FastifyInstance) {
  app.get('/matches', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { data: blockRows } = await db
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId},blocked_id.eq.${req.userId}`)
    const blockedIds = new Set(
      (blockRows ?? []).map((b: { blocker_id: string; blocked_id: string }) =>
        b.blocker_id === req.userId ? b.blocked_id : b.blocker_id
      )
    )

    const { data: rows } = await db
      .from('matches')
      .select(`
        id, created_at, user1_id, user2_id,
        user1:users!matches_user1_id_fkey(id, name, telegram_id, username, deleted_at, age, bio, icebreaker_prompt, icebreaker_answer),
        user2:users!matches_user2_id_fkey(id, name, telegram_id, username, deleted_at, age, bio, icebreaker_prompt, icebreaker_answer)
      `)
      .or(`user1_id.eq.${req.userId},user2_id.eq.${req.userId}`)
      .order('created_at', { ascending: false })

    const activeRows = (rows ?? []).filter((row: any) => {
      const other = row.user1_id === req.userId ? row.user2 : row.user1
      return !other.deleted_at && !blockedIds.has(other.id)
    })

    const matches = await Promise.all(
      activeRows.map(async (row: any) => {
        const other = row.user1_id === req.userId ? row.user2 : row.user1

        const { data: photos } = await db
          .from('user_photos')
          .select('url, position')
          .eq('user_id', other.id)
          .order('position', { ascending: true })

        const { data: lastMsgRows } = await db
          .from('messages')
          .select('body, created_at, sender_id')
          .eq('match_id', row.id)
          .order('created_at', { ascending: false })
          .limit(1)

        const { count: unreadCount } = await db
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('match_id', row.id)
          .neq('sender_id', req.userId)
          .is('read_at', null)

        const lastMsg = lastMsgRows?.[0]

        return {
          id: row.id,
          matchedAt: row.created_at,
          user: {
            id: other.id,
            name: other.name,
            telegramId: other.telegram_id,
            username: other.username,
            age: other.age ?? null,
            bio: other.bio ?? null,
            icebreakerPrompt: other.icebreaker_prompt ?? null,
            icebreakerAnswer: other.icebreaker_answer ?? null,
            photos: (photos ?? []).map((p: { url: string }) => p.url),
          },
          lastMessage: lastMsg
            ? { body: lastMsg.body, createdAt: lastMsg.created_at, senderId: lastMsg.sender_id }
            : null,
          unreadCount: unreadCount ?? 0,
        }
      })
    )

    return { matches }
  })

  app.get('/matches/unread-count', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { data: rows } = await db
      .from('matches')
      .select(`
        id, user1_id, user2_id,
        user1:users!matches_user1_id_fkey(deleted_at),
        user2:users!matches_user2_id_fkey(deleted_at)
      `)
      .or(`user1_id.eq.${req.userId},user2_id.eq.${req.userId}`)

    const activeMatchIds = (rows ?? [])
      .filter((row: any) => {
        const other = row.user1_id === req.userId ? row.user2 : row.user1
        return !other.deleted_at
      })
      .map((row: any) => row.id)

    if (activeMatchIds.length === 0) return { count: 0 }

    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('match_id', activeMatchIds)
      .neq('sender_id', req.userId)
      .is('read_at', null)

    return { count: count ?? 0 }
  })
}
