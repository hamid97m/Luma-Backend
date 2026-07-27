import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { verifyInitData } from '../auth.js'

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/verify', async (req, reply) => {
    const { initData } = req.body as { initData: string }

    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    // Find or create user
    const { data: existing } = await db
      .from('users')
      .select('id, name, age, gender, looking_for, bio')
      .eq('telegram_id', tgUser.id)
      .single()

    let userId: string
    let userName: string

    if (existing) {
      userId = existing.id
      userName = existing.name
      // Update last_active
      await db.from('users').update({ last_active: new Date().toISOString() }).eq('id', userId)
    } else {
      const { data: created, error } = await db
        .from('users')
        .insert({
          telegram_id: tgUser.id,
          username: tgUser.username ?? null,
          name: tgUser.first_name,
          // age, gender, looking_for will be set during profile setup
          age: 0,
          gender: 'man',
          looking_for: 'women',
        })
        .select('id, name')
        .single()

      if (error || !created) return reply.status(500).send({ error: 'user_creation_failed' })
      userId = created.id
      userName = created.name
    }

    // Check if setup is complete (has age > 0 and at least one photo)
    const profile = existing ?? { age: 0 }
    const { data: photos } = await db
      .from('user_photos')
      .select('id')
      .eq('user_id', userId)

    const setupComplete = profile.age > 0 && (photos?.length ?? 0) > 0

    return {
      user: {
        id: userId,
        name: userName,
        setupComplete,
      },
    }
  })
}
