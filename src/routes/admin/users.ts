import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
import { notifyPaused, sendBroadcastMessage, forwardBroadcastMessage } from '../../bot.js'
import { deleteAllPhotosForUser } from '../../photos/deleteAllPhotosForUser.js'
import { validateButton } from '../../messaging/messageButton.js'
import { parseChannelMessageLink } from '../../messaging/channelLink.js'
import { scheduleUserGeo } from '../../geo/resolveCity.js'
import { isLocale, type Locale } from '../../i18n/index.js'

export const PAGE_SIZE = 20

const GENDERS = ['man', 'woman', 'nonbinary']
const LOOKING = ['men', 'women', 'both', 'everyone']

export function toListItem(u: any) {
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.username,
    name: u.name,
    age: u.age,
    gender: u.gender,
    lookingFor: u.looking_for,
    isActive: u.is_active,
    isSeed: u.is_seed,
    bannedAt: u.banned_at,
    pausedAt: u.paused_at,
    deletedAt: u.deleted_at,
    accountStatus: u.account_status === 'active' ? 'active' : 'preparing',
    createdAt: u.created_at,
    lastActive: u.last_active,
    geoCity: u.geo_city ?? null,
    geoCountry: u.geo_country ?? null,
    locale: u.locale ?? null,
  }
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get('/users', async (req, reply) => {
    const { query = '', status = 'all', gender = 'all', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    const statusFilter =
      status === 'active' ? sql`and account_status = 'active' and deleted_at is null and banned_at is null`
      : status === 'preparing' ? sql`and account_status = 'preparing' and deleted_at is null and banned_at is null`
      : status === 'banned' ? sql`and banned_at is not null`
      : status === 'deleted' ? sql`and deleted_at is not null`
      : status === 'seed' ? sql`and is_seed = true`
      : sql``

    const genderFilter = GENDERS.includes(gender) ? sql`and gender = ${gender}` : sql``

    // Strip separators/quotes so search behaviour stays stable. The term is a
    // bind parameter. `%`/`_` stay wildcards, and `*` too (an alias of `%`).
    const search = query.trim().replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim()
    let searchFilter = sql``
    if (search) {
      const pattern = `%${search.replace(/\*/g, '%')}%`
      searchFilter = /^-?\d+$/.test(search)
        ? sql`and (name ilike ${pattern} or username ilike ${pattern} or telegram_id = ${search}::bigint)`
        : sql`and (name ilike ${pattern} or username ilike ${pattern})`
    }

    // Admins see every user, deleted ones included (unless a status filter says otherwise).
    let data: any[]
    let count: number
    try {
      ;[data, [{ count }]] = await Promise.all([
        sql`
          select id, telegram_id, username, name, age, gender, looking_for, is_active, is_seed,
                 banned_at, paused_at, deleted_at, created_at, last_active, geo_city, geo_country,
                 locale, account_status
          from users
          where true ${statusFilter} ${genderFilter} ${searchFilter}
          order by created_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`
          select count(*)::int as count from users
          where true ${statusFilter} ${genderFilter} ${searchFilter}`,
      ])
    } catch (err) {
      req.log.error({ err }, 'users fetch failed')
      return reply.status(500).send({ error: 'users_fetch_failed' })
    }

    const total = count ?? 0
    return {
      items: (data ?? []).map(toListItem),
      total,
      page: pageNum,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })

  app.post('/users', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const age = Number(body.age)
    const gender = body.gender as string
    const looking_for = body.looking_for as string
    const photos = Array.isArray(body.photos)
      ? (body.photos as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
      : []

    if (!name) return reply.status(400).send({ error: 'invalid_name' })
    if (!Number.isInteger(age) || age < 18 || age > 99) return reply.status(400).send({ error: 'invalid_age' })
    if (!GENDERS.includes(gender)) return reply.status(400).send({ error: 'invalid_gender' })
    if (!LOOKING.includes(looking_for)) return reply.status(400).send({ error: 'invalid_looking_for' })
    if (photos.length > 6) return reply.status(400).send({ error: 'too_many_photos' })
    // Omitted language is Persian: the current fake profiles are Iranian.
    const locale = body.locale === undefined ? 'fa' : body.locale
    if (!isLocale(locale)) return reply.status(400).send({ error: 'invalid_locale' })

    let user: { id: string } | undefined
    try {
      ;[user] = await sql<{ id: string }[]>`
        insert into users ${sql({
          telegram_id: -Date.now(),
          name,
          age,
          gender,
          looking_for,
          bio: typeof body.bio === 'string' ? body.bio : null,
          interests: Array.isArray(body.interests) ? body.interests : [],
          location: typeof body.location === 'string' ? body.location : null,
          icebreaker_prompt: typeof body.icebreaker_prompt === 'string' ? body.icebreaker_prompt : null,
          icebreaker_answer: typeof body.icebreaker_answer === 'string' ? body.icebreaker_answer : null,
          locale,
          is_seed: true,
          is_active: true,
          // A seed is discoverable only once it has a city and a photo, same bar
          // as a finished signup. Age is already validated above.
          account_status: (typeof body.location === 'string' && body.location.trim().length >= 2 && photos.length > 0)
            ? 'active'
            : 'preparing',
        } as Record<string, any>)}
        returning id`
    } catch (err) {
      req.log.error({ err }, 'seed user create failed')
    }

    if (!user) return reply.status(500).send({ error: 'create_failed' })

    scheduleUserGeo(user.id, typeof body.location === 'string' ? body.location : null, req.log)

    if (photos.length) {
      const userId = user.id
      try {
        await sql`insert into user_photos ${sql(photos.map((url, i) => ({ user_id: userId, url, position: i })))}`
      } catch (photoErr) {
        req.log.warn({ err: photoErr }, 'failed to insert seed photos')
      }
    }

    return reply.status(201).send({ id: user.id })
  })

  app.get('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    // Malformed id or a failed lookup → 404.
    let user: any
    try {
      ;[user] = isUuid(id) ? await sql`select * from users where id = ${id}` : []
    } catch (err) {
      req.log.error({ err }, 'user detail lookup failed')
    }
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    try {
      const [photos, [counts], matchRows] = await Promise.all([
        sql<{ url: string }[]>`select url, position from user_photos where user_id = ${id} order by position asc`,
        sql<{ swipes_given: number; likes_received: number; messages_sent: number }[]>`
          select
            (select count(*)::int from swipes where swiper_id = ${id}) as swipes_given,
            (select count(*)::int from swipes where swiped_id = ${id} and direction = 'like') as likes_received,
            (select count(*)::int from messages where sender_id = ${id} and type <> 'icebreaker') as messages_sent`,
        // The other participant of each match, with their lowest-position photo.
        sql<{ id: string; created_at: string; other_id: string | null; other_name: string | null; other_photo: string | null }[]>`
          select m.id, m.created_at, o.id as other_id, o.name as other_name,
                 (select p.url from user_photos p where p.user_id = o.id order by p.position asc limit 1) as other_photo
          from matches m
          left join users o on o.id = case when m.user1_id = ${id} then m.user2_id else m.user1_id end
          where m.user1_id = ${id} or m.user2_id = ${id}
          order by m.created_at desc`,
      ])
      const swipesGiven = counts.swipes_given
      const likesReceived = counts.likes_received
      const messagesSent = counts.messages_sent

      const matches = matchRows.map((row) => ({
        matchId: row.id,
        matchedAt: row.created_at,
        user: { id: row.other_id ?? null, name: row.other_name ?? '', photo: row.other_photo ?? null },
      }))

      return {
        user: {
          ...toListItem(user),
          lookingFor: user.looking_for,
          bio: user.bio,
          interests: user.interests ?? [],
          location: user.location,
          icebreakerPrompt: user.icebreaker_prompt,
          icebreakerAnswer: user.icebreaker_answer,
          allowsWriteToPm: user.allows_write_to_pm,
          premiumUntil: user.premium_until ?? null,
          photos: (photos ?? []).map((p: any) => p.url),
        },
        counts: { swipesGiven, likesReceived, matches: matches.length, messagesSent },
        matches,
      }
    } catch (err) {
      req.log.error({ err }, 'user detail fetch failed')
      return reply.status(500).send({ error: 'user_detail_fetch_failed' })
    }
  })

  // Fetches the user and enforces the seed-only guard shared by edit/delete.
  // Sends the error reply itself and returns null when the guard fails.
  const fetchSeedUser = async (id: string, reply: any) => {
    let user: { id: string; is_seed: boolean } | undefined
    try {
      ;[user] = isUuid(id)
        ? await sql<{ id: string; is_seed: boolean }[]>`select id, is_seed from users where id = ${id}`
        : []
    } catch { /* treated as not found */ }
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' })
      return null
    }
    if (!user.is_seed) {
      reply.status(400).send({ error: 'not_a_seed_user' })
      return null
    }
    return user
  }

  app.put('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    const user = await fetchSeedUser(id, reply)
    if (!user) return reply

    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return reply.status(400).send({ error: 'invalid_name' })
      patch.name = name
    }
    if ('age' in body) {
      const age = Number(body.age)
      if (!Number.isInteger(age) || age < 18 || age > 99) return reply.status(400).send({ error: 'invalid_age' })
      patch.age = age
    }
    if ('gender' in body) {
      if (!GENDERS.includes(body.gender as string)) return reply.status(400).send({ error: 'invalid_gender' })
      patch.gender = body.gender
    }
    if ('looking_for' in body) {
      if (!LOOKING.includes(body.looking_for as string)) return reply.status(400).send({ error: 'invalid_looking_for' })
      patch.looking_for = body.looking_for
    }
    for (const field of ['bio', 'location', 'icebreaker_prompt', 'icebreaker_answer']) {
      if (field in body) {
        const value = body[field]
        if (value !== null && typeof value !== 'string') return reply.status(400).send({ error: `invalid_${field}` })
        patch[field] = value
      }
    }
    if ('interests' in body) {
      if (!Array.isArray(body.interests) || !body.interests.every((i) => typeof i === 'string')) {
        return reply.status(400).send({ error: 'invalid_interests' })
      }
      patch.interests = body.interests
    }
    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') return reply.status(400).send({ error: 'invalid_is_active' })
      patch.is_active = body.is_active
    }
    if ('locale' in body) {
      if (!isLocale(body.locale)) return reply.status(400).send({ error: 'invalid_locale' })
      patch.locale = body.locale
    }

    let photos: string[] | null = null
    if ('photos' in body) {
      if (
        !Array.isArray(body.photos) ||
        !body.photos.every((u): u is string => typeof u === 'string' && u.length > 0)
      ) {
        return reply.status(400).send({ error: 'invalid_photos' })
      }
      if (body.photos.length > 6) return reply.status(400).send({ error: 'too_many_photos' })
      photos = body.photos
    }

    if (Object.keys(patch).length === 0 && photos === null) {
      return reply.status(400).send({ error: 'empty_update' })
    }

    if ('location' in patch) {
      patch.geo_city = null
      patch.geo_country = null
    }

    if (Object.keys(patch).length > 0) {
      try {
        await sql`update users set ${sql(patch as Record<string, any>)} where id = ${id}`
      } catch (err) {
        req.log.error({ err }, 'seed user update failed')
        return reply.status(500).send({ error: 'update_failed' })
      }
      if ('location' in patch) scheduleUserGeo(id, patch.location as string | null, req.log)
    }

    if (photos !== null) {
      // Replace-all semantics: wipe existing rows, then re-insert in order.
      // In one transaction, so a failed insert no longer leaves the fake photo-less.
      const newPhotos = photos
      try {
        await sql.begin(async (tx) => {
          await tx`delete from user_photos where user_id = ${id}`
          if (newPhotos.length) {
            await tx`insert into user_photos ${tx(newPhotos.map((url, i) => ({ user_id: id, url, position: i })))}`
          }
        })
      } catch (err) {
        req.log.error({ err }, 'seed photos update failed')
        return reply.status(500).send({ error: 'photos_update_failed' })
      }
    }

    return { ok: true }
  })

  app.delete('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    const user = await fetchSeedUser(id, reply)
    if (!user) return reply

    // Soft delete: swipes/matches/messages FK-reference users without ON DELETE CASCADE, so a hard
    // delete would violate FKs once the fake has activity; deleted_at also removes it from the
    // fake-liker pool (which filters is('deleted_at', null)).
    try {
      await sql`update users set deleted_at = ${new Date().toISOString()}, is_active = false where id = ${id}`
    } catch (err) {
      req.log.error({ err }, 'seed user delete failed')
      return reply.status(500).send({ error: 'delete_failed' })
    }

    return { ok: true }
  })

  const setBanned = async (id: string, bannedAt: string | null, reply: any) => {
    let data: { id: string } | undefined
    try {
      ;[data] = isUuid(id)
        ? await sql<{ id: string }[]>`update users set banned_at = ${bannedAt} where id = ${id} returning id`
        : []
    } catch { /* any failure answered 404 before, too */ }
    if (!data) return reply.status(404).send({ error: 'user_not_found' })
    return { ok: true }
  }

  app.post('/users/:id/ban', async (req, reply) => {
    const { id } = req.params as { id: string }
    return setBanned(id, new Date().toISOString(), reply)
  })

  app.post('/users/:id/unban', async (req, reply) => {
    const { id } = req.params as { id: string }
    return setBanned(id, null, reply)
  })

  const setPaused = async (id: string, pausedAt: string | null, reply: any) => {
    type Paused = { telegram_id: number; allows_write_to_pm: boolean | null; locale: Locale | null }
    let data: Paused | undefined
    try {
      ;[data] = isUuid(id)
        ? await sql<Paused[]>`
            update users set paused_at = ${pausedAt} where id = ${id}
            returning telegram_id, allows_write_to_pm, locale`
        : []
    } catch { /* any failure answered 404 before, too */ }
    if (!data) return reply.status(404).send({ error: 'user_not_found' })

    // Pausing for photo review means the user must re-upload from scratch;
    // best-effort by construction, never blocks the pause response.
    if (pausedAt) await deleteAllPhotosForUser(id)

    // Warn the user only when pausing (not on resume), and only if bot DMs are
    // not explicitly declined.
    if (pausedAt && data.telegram_id > 0 && data.allows_write_to_pm !== false) {
      notifyPaused(data.telegram_id, data.locale ?? null).catch((err) =>
        console.error('[admin] notifyPaused failed:', err?.message ?? err))
    }
    return { ok: true }
  }

  app.post('/users/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string }
    return setPaused(id, new Date().toISOString(), reply)
  })

  app.post('/users/:id/unpause', async (req, reply) => {
    const { id } = req.params as { id: string }
    return setPaused(id, null, reply)
  })

  // Send a one-off bot DM to a single user (admin override: reaches opted-out
  // and paused/banned users; only seed/fake users with no real Telegram chat
  // are rejected).
  app.post('/users/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { kind?: string; text?: string; link?: string; button?: unknown }
    const isForward = body.kind === 'forward'

    // Validate the payload (per kind) and build the per-user delivery closure
    // before we touch the DB, so a bad request never does a pointless lookup.
    let deliver: (telegramId: number) => Promise<void>
    if (isForward) {
      const parsed = parseChannelMessageLink(body.link ?? '')
      if (!parsed) return reply.status(400).send({ error: 'invalid_link' })
      deliver = (telegramId) => forwardBroadcastMessage(telegramId, parsed.chatId, parsed.messageId)
    } else {
      const trimmed = (body.text ?? '').trim()
      if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
      if (trimmed.length > 4096) return reply.status(400).send({ error: 'message_too_long' })
      const btn = validateButton(body.button)
      if (!btn.ok) return reply.status(400).send({ error: btn.error })
      deliver = (telegramId) => sendBroadcastMessage(telegramId, trimmed, btn.button)
    }

    let user: { telegram_id: number; is_seed: boolean } | undefined
    try {
      ;[user] = isUuid(id)
        ? await sql<{ telegram_id: number; is_seed: boolean }[]>`select telegram_id, is_seed from users where id = ${id}`
        : []
    } catch (err) {
      req.log.error({ err }, 'user lookup failed')
      return reply.status(500).send({ error: 'user_fetch_failed' })
    }
    if (!user) return reply.status(404).send({ error: 'user_not_found' })
    if ((user as any).is_seed || (user as any).telegram_id <= 0) {
      return reply.status(400).send({ error: 'not_messageable' })
    }

    try {
      await deliver((user as any).telegram_id)
      return { ok: true }
    } catch (err: any) {
      // 403 = the user has blocked the bot. Surface it; leave allows_write_to_pm as-is.
      if (err?.error_code === 403) {
        return reply.status(409).send({ error: 'user_blocked_bot' })
      }
      req.log.error({ err }, 'admin user message send failed')
      return reply.status(502).send({ error: 'send_failed' })
    }
  })
}

export { GENDERS, LOOKING }
