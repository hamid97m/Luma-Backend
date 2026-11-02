import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'

export async function blockRoutes(app: FastifyInstance) {
  app.post('/block', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const userId = typeof body.userId === 'string' ? body.userId : ''

    if (!userId) return reply.status(400).send({ error: 'invalid_block' })
    if (userId === req.userId) return reply.status(400).send({ error: 'cannot_block_self' })

    // Not a UUID can't be a user — answer 404 instead of letting Postgres reject the cast.
    const [target] = isUuid(userId)
      ? await sql`select id from users where id = ${userId}`
      : []
    if (!target) return reply.status(404).send({ error: 'user_not_found' })

    // Directional block. Discovery, matches, likes and direct-chat already filter
    // on this table (either direction), so the pair disappears from each other's
    // feed and match list once the row exists. Ignore duplicates.
    await sql`
      insert into blocks (blocker_id, blocked_id) values (${req.userId}, ${userId})
      on conflict (blocker_id, blocked_id) do nothing`

    return { ok: true }
  })
}
