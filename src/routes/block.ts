import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

export async function blockRoutes(app: FastifyInstance) {
  app.post('/block', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const userId = typeof body.userId === 'string' ? body.userId : ''

    if (!userId) return reply.status(400).send({ error: 'invalid_block' })
    if (userId === req.userId) return reply.status(400).send({ error: 'cannot_block_self' })

    const { data: target } = await db.from('users').select('id').eq('id', userId).single()
    if (!target) return reply.status(404).send({ error: 'user_not_found' })

    // Directional block. Discovery, matches, likes and direct-chat already filter
    // on this table (either direction), so the pair disappears from each other's
    // feed and match list once the row exists. Ignore duplicates.
    await db.from('blocks').upsert(
      { blocker_id: req.userId, blocked_id: userId },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    )

    return { ok: true }
  })
}
