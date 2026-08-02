import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

export async function matchesRoutes(app: FastifyInstance) {
  app.get('/matches', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { data: rows } = await db
      .from('matches')
      .select(`
        id, created_at, user1_id, user2_id,
        user1:users!matches_user1_id_fkey(id, name, telegram_id, username, deleted_at),
        user2:users!matches_user2_id_fkey(id, name, telegram_id, username, deleted_at)
      `)
      .or(`user1_id.eq.${req.userId},user2_id.eq.${req.userId}`)
      .order('created_at', { ascending: false })

    const activeRows = (rows ?? []).filter((row: any) => {
      const other = row.user1_id === req.userId ? row.user2 : row.user1
      return !other.deleted_at
    })

    const matches = await Promise.all(
      activeRows.map(async (row: any) => {
        const other = row.user1_id === req.userId ? row.user2 : row.user1

        const { data: photos } = await db
          .from('user_photos')
          .select('url, position')
          .eq('user_id', other.id)
          .order('position', { ascending: true })

        return {
          id: row.id,
          matchedAt: row.created_at,
          user: {
            id: other.id,
            name: other.name,
            telegramId: other.telegram_id,
            username: other.username,
            photos: (photos ?? []).map((p: { url: string }) => p.url),
          },
        }
      })
    )

    return { matches }
  })
}
