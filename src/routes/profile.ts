import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import * as storage from '../storage.js'
import { icebreakerIndex } from '../icebreakers/catalog.js'
import { maybeQualifyReferral } from '../referrals/rewards.js'
import { isLocale } from '../i18n/index.js'
import { scheduleUserGeo } from '../geo/resolveCity.js'
import { scheduleMainPhotoCheck } from '../moderation/photoAiCheck.js'
import { markActiveIfSignupComplete } from '../users/accountStatus.js'

type Photo = { id: string; url: string; position: number }

/** The user's photos in display order. A failed read counts as no photos
 *  (supabase-js callers ignored this error). */
async function listPhotos(userId: string): Promise<Photo[]> {
  try {
    return await sql<Photo[]>`
      select id, url, position from user_photos
      where user_id = ${userId}
      order by position asc`
  } catch {
    return []
  }
}

export async function getProfileWithPhotos(userId: string) {
  let user
  try {
    ;[user] = await sql`
      select id, name, age, gender, looking_for, bio, interests, location, icebreaker_prompt,
             icebreaker_answer, is_active, paused_at, locale, account_status
      from users where id = ${userId}`
  } catch {
    return null
  }
  if (!user) return null

  const photos = await listPhotos(userId)

  await markActiveIfSignupComplete(userId, user, photos.length)

  const setupComplete = user.age > 0

  return { ...user, photos, setupComplete, paused: Boolean(user.paused_at) }
}

export async function profileRoutes(app: FastifyInstance) {
  app.get('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const profile = await getProfileWithPhotos(req.userId)
    if (!profile) return reply.status(404).send({ error: 'user_not_found' })
    return profile
  })

  app.put('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const allowed = ['name', 'age', 'gender', 'looking_for', 'bio', 'interests', 'location', 'icebreaker_prompt', 'icebreaker_answer', 'is_active', 'locale'] as const
    const body = req.body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'no_fields' })
    }

    // A name must be at least 2 chars and contain no digits — Latin (0-9),
    // Persian (۰-۹) or Arabic-Indic (٠-٩). Mirrors the client-side rule.
    if ('name' in updates) {
      const trimmed = typeof updates.name === 'string' ? updates.name.trim() : ''
      if (trimmed.length < 2 || /[0-9۰-۹٠-٩]/.test(trimmed)) {
        return reply.status(400).send({ error: 'invalid_name' })
      }
      updates.name = trimmed
    }

    // Age is required and must be a whole number in [18, 99].
    if ('age' in updates) {
      const age = Number(updates.age)
      if (!Number.isInteger(age) || age < 18 || age > 99) {
        return reply.status(400).send({ error: 'invalid_age' })
      }
      updates.age = age
    }

    if ('locale' in updates && !isLocale(updates.locale)) {
      return reply.status(400).send({ error: 'invalid_locale' })
    }

    // Users pick from the catalog; only admins may set a custom prompt.
    if ('icebreaker_prompt' in updates) {
      const prompt = updates.icebreaker_prompt
      if (prompt !== null && (typeof prompt !== 'string' || icebreakerIndex(prompt) === null)) {
        return reply.status(400).send({ error: 'invalid_icebreaker' })
      }
    }

    if ('icebreaker_answer' in updates) {
      const answer = updates.icebreaker_answer
      if (answer !== null) {
        if (typeof answer !== 'string') return reply.status(400).send({ error: 'invalid_icebreaker' })
        const trimmed = answer.trim()
        if (trimmed.length > 140) return reply.status(400).send({ error: 'invalid_icebreaker' })
        updates.icebreaker_answer = trimmed || null
      }
    }

    // City is free text stored in `location`. Required when sent: 2–40 chars,
    // at least one letter, no digits. Mirrors frontend/src/utils/validateCity.ts.
    if ('location' in updates) {
      const raw = updates.location
      const trimmed = typeof raw === 'string' ? raw.trim() : ''
      const cityOk =
        trimmed.length >= 2 &&
        trimmed.length <= 40 &&
        !/[0-9۰-۹٠-٩]/.test(trimmed) &&
        /\p{L}/u.test(trimmed)
      if (!cityOk) return reply.status(400).send({ error: 'invalid_location' })
      updates.location = trimmed
      // Hidden discovery geo is re-resolved in the background after the save;
      // clear it now so the old city never outlives the new text.
      updates.geo_city = null
      updates.geo_country = null
    }

    let user
    try {
      ;[user] = await sql`
        update users set ${sql({ ...updates, last_active: new Date().toISOString() })}
        where id = ${req.userId}
        returning id, name, age, gender, looking_for, bio, interests, location, icebreaker_prompt,
                  icebreaker_answer, is_active, locale, account_status`
    } catch (err) {
      // e.g. an invalid enum value for gender/looking_for, or a null interests.
      req.log.warn({ err }, 'profile update failed')
      user = undefined
    }

    if (!user) return reply.status(500).send({ error: 'update_failed' })

    if ('location' in updates) scheduleUserGeo(req.userId, user.location, req.log)
    // Onboarding uploads the first photo before gender is saved.
    if ('gender' in updates) scheduleMainPhotoCheck(req.userId, req.log)

    const photos = await listPhotos(req.userId)

    await markActiveIfSignupComplete(req.userId, user, photos.length)
    await maybeQualifyReferral(req.userId)

    return {
      ...user,
      photos,
      setupComplete: user.age > 0,
    }
  })

  // Recorded when the user answers the in-app requestWriteAccess() popup —
  // initData only refreshes on the next launch, so without this a mid-session
  // grant would stay invisible until the app is reopened.
  app.post('/profile/me/write-access', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { granted } = req.body as { granted?: boolean }
    if (typeof granted !== 'boolean') return reply.status(400).send({ error: 'invalid_granted' })

    try {
      await sql`update users set allows_write_to_pm = ${granted} where id = ${req.userId}`
    } catch {
      return reply.status(500).send({ error: 'update_failed' })
    }
    return { ok: true }
  })

  // Lightweight language switch for the Settings screen and the first-open
  // picker — no profile re-fetch, no last_active bump.
  app.patch('/profile/me/locale', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { locale } = (req.body ?? {}) as { locale?: unknown }
    if (!isLocale(locale)) return reply.status(400).send({ error: 'invalid_locale' })

    try {
      await sql`update users set locale = ${locale} where id = ${req.userId}`
    } catch {
      return reply.status(500).send({ error: 'update_failed' })
    }
    return { ok: true, locale }
  })

  app.delete('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    // A failed read was ignored (treated as no photos) — kept.
    const photos = await sql<{ id: string }[]>`select id from user_photos where user_id = ${req.userId}`
      .catch(() => [] as { id: string }[])

    if (photos.length) {
      await storage.remove('profile-photos', photos.map((p) => `${req.userId}/${p.id}`)).catch((storageError) => {
        console.error(`Failed to remove profile photos for user ${req.userId}:`, storageError)
      })
      try {
        await sql`delete from user_photos where user_id = ${req.userId}`
      } catch {
        return reply.status(500).send({ error: 'delete_failed' })
      }
    }

    try {
      await sql`
        update users set ${sql({
          name: '',
          bio: null,
          interests: [],
          location: null,
          geo_city: null,
          geo_country: null,
          icebreaker_prompt: null,
          icebreaker_answer: null,
          age: 0,
          is_active: false,
          account_status: 'preparing',
          // NULL = "never chose a language": a re-signup goes through the
          // first-open picker again instead of inheriting the old choice.
          locale: null,
          deleted_at: new Date().toISOString(),
        })}
        where id = ${req.userId}`
    } catch {
      return reply.status(500).send({ error: 'delete_failed' })
    }

    return { ok: true }
  })
}
