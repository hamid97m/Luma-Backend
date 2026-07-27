import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { notifyMatch } from '../bot.js'

export async function swipesRoutes(app: FastifyInstance) {
  app.post('/swipes', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { targetUserId, direction } = req.body as {
      targetUserId: string
      direction: 'like' | 'pass'
    }

    // Insert swipe; UNIQUE constraint prevents duplicates
    const { error: swipeErr } = await db.from('swipes').insert({
      swiper_id: req.userId,
      swiped_id: targetUserId,
      direction,
    })

    if (swipeErr?.code === '23505') return { matched: false } // already swiped
    if (swipeErr) return reply.status(500).send({ error: 'swipe_failed' })

    if (direction === 'pass') return { matched: false }

    // Check for reverse like
    const { data: reverseSwipe } = await db
      .from('swipes')
      .select('id')
      .eq('swiper_id', targetUserId)
      .eq('swiped_id', req.userId)
      .eq('direction', 'like')
      .single()

    if (!reverseSwipe) return { matched: false }

    // Normalise pair order so UNIQUE(user1_id, user2_id) is deterministic
    const [u1, u2] = [req.userId, targetUserId].sort()

    const { data: match, error: matchErr } = await db
      .from('matches')
      .insert({ user1_id: u1, user2_id: u2 })
      .select('id')
      .single()

    if (matchErr?.code === '23505') return { matched: false } // race — already matched
    if (matchErr) return reply.status(500).send({ error: 'match_failed' })

    // Fetch both users for notification
    const { data: users } = await db
      .from('users')
      .select('id, name, telegram_id')
      .in('id', [req.userId, targetUserId])

    const me = users!.find((u: { id: string }) => u.id === req.userId)!
    const them = users!.find((u: { id: string }) => u.id === targetUserId)!

    // Fire-and-forget
    notifyMatch(me.telegram_id, me.name, them.telegram_id, them.name).catch(console.error)

    return {
      matched: true,
      match: {
        id: match!.id,
        user: { id: them.id, name: them.name, telegramId: them.telegram_id },
      },
    }
  })
}
