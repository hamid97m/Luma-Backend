import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { verifyInitData } from '../auth.js'
import { getBotUsername } from '../bot.js'
import { getProfileWithPhotos } from './profile.js'
import { captureReferralAttribution } from '../referrals/attribution.js'

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

    // Find or create user. A failed lookup was treated as "no such user" (the
    // insert then fails on the unique telegram_id and answers 500) — kept.
    type ExistingUser = {
      id: string; name: string; age: number; gender: string; looking_for: string
      bio: string | null; deleted_at: string | null; banned_at: string | null; locale: string | null
    }
    let existing: ExistingUser | undefined
    try {
      ;[existing] = await sql<ExistingUser[]>`
        select id, name, age, gender, looking_for, bio, deleted_at, banned_at, locale
        from users where telegram_id = ${tgUser.id}`
    } catch {
      existing = undefined
    }

    if (existing?.banned_at) {
      // botUsername lets the Blocked screen deep-link into the support bot chat.
      return reply.status(401).send({ error: 'account_banned', botUsername: getBotUsername() })
    }

    let userId: string
    let userName: string

    if (existing) {
      userId = existing.id
      userName = existing.name
      const reactivating = Boolean(existing.deleted_at)
      try {
        await sql`
          update users set ${sql({
            last_active: new Date().toISOString(),
            ...writeAccess,
            ...(reactivating ? { deleted_at: null, is_active: true } : {}),
          })}
          where id = ${userId}`
      } catch {
        return reply.status(500).send({ error: 'auth_update_failed' })
      }
    } else {
      let created: { id: string; name: string } | undefined
      try {
        ;[created] = await sql<{ id: string; name: string }[]>`
          insert into users ${sql({
            telegram_id: tgUser.id,
            username: tgUser.username ?? null,
            name: tgUser.first_name,
            ...writeAccess,
            // age, gender, looking_for will be set during profile setup
            age: 0,
            gender: 'man',
            looking_for: 'women',
          })}
          returning id, name`
      } catch {
        created = undefined
      }

      if (!created) return reply.status(500).send({ error: 'user_creation_failed' })
      userId = created.id
      userName = created.name

      const startParam = new URLSearchParams(initData).get('start_param')
      await captureReferralAttribution(created.id, tgUser.id, startParam)
    }

    const profile = existing ?? { age: 0 }
    const setupComplete = profile.age > 0

    if (setupComplete) {
      const fullProfile = await getProfileWithPhotos(userId)
      if (fullProfile) return { user: fullProfile }
    }

    // null = the user has never picked a language; the client shows the
    // first-open picker. Never default to 'fa' here.
    return {
      user: {
        id: userId,
        name: userName,
        setupComplete,
        locale: existing?.locale ?? null,
      },
    }
  })
}
