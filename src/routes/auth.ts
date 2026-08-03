import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { verifyInitData } from '../auth.js'
import { getProfileWithPhotos } from './profile.js'

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/verify', async (req, reply) => {
    const body = req.body as { initData?: string }
    const { initData } = body
    if (typeof initData !== 'string' || !initData) {
      return reply.status(400).send({ error: 'missing_init_data' })
    }

    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    // Only write the flag when Telegram actually sent it — old clients omit
    // the field entirely, and that absence must not wipe a known value.
    const writeAccess =
      typeof tgUser.allows_write_to_pm === 'boolean'
        ? { allows_write_to_pm: tgUser.allows_write_to_pm }
        : {}

    // Find or create user
    const { data: existing } = await db
      .from('users')
      .select('id, name, age, gender, looking_for, bio, deleted_at')
      .eq('telegram_id', tgUser.id)
      .single()

    let userId: string
    let userName: string

    if (existing) {
      userId = existing.id
      userName = existing.name
      const reactivating = Boolean(existing.deleted_at)
      const { error: updateError } = await db.from('users').update({
        last_active: new Date().toISOString(),
        ...writeAccess,
        ...(reactivating ? { deleted_at: null, is_active: true } : {}),
      }).eq('id', userId)
      if (updateError) return reply.status(500).send({ error: 'auth_update_failed' })
    } else {
      const { data: created, error } = await db
        .from('users')
        .insert({
          telegram_id: tgUser.id,
          username: tgUser.username ?? null,
          name: tgUser.first_name,
          ...writeAccess,
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

    const profile = existing ?? { age: 0 }
    const setupComplete = profile.age > 0

    if (setupComplete) {
      const fullProfile = await getProfileWithPhotos(userId)
      if (fullProfile) return { user: fullProfile }
    }

    return {
      user: {
        id: userId,
        name: userName,
        setupComplete,
      },
    }
  })
}
