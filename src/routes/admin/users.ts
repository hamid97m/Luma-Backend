import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
import { sendBroadcastMessage, forwardBroadcastMessage } from '../../bot.js'
import { notifyUserPaused, notifyUserText } from '../../notify/userNotify.js'
import { sendPushToUser, isPushConfigured } from '../../push/fcm.js'
import { appLink } from '../../push/links.js'
import { isStandby } from '../../appMode.js'
import { deleteAllPhotosForUser } from '../../photos/deleteAllPhotosForUser.js'
import { validateButton, type MessageButton } from '../../messaging/messageButton.js'
import { parseChannelMessageLink } from '../../messaging/channelLink.js'
import { scheduleUserGeo } from '../../geo/resolveCity.js'
import { isLocale, type Locale } from '../../i18n/index.js'

export const PAGE_SIZE = 20

const GENDERS = ['man', 'woman', 'nonbinary']
const LOOKING = ['men', 'women', 'both', 'everyone']

// Seeds have negative telegram_ids and website users have none: neither signed in with Telegram.
// A Google account's email is its Google identity, not a separate email login.
function signInMethods(u: any): ('telegram' | 'google' | 'email')[] {
  const methods: ('telegram' | 'google' | 'email')[] = []
  if (u.telegram_id > 0) methods.push('telegram')
  if (u.google_sub) methods.push('google')
  if (u.email && !u.google_sub) methods.push('email')
  return methods
}

export function toListItem(u: any) {
  return {
    id: u.id,
    telegramId: (u.telegram_id ?? null) as number | null,
    email: (u.email ?? null) as string | null,
    signInMethods: signInMethods(u),
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
    joinTag: (u.join_tag ?? null) as string | null,
  }
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get('/users', async (req, reply) => {
    const { query = '', status = 'all', gender = 'all', tag = '', page = '1' } = req.query as Record<string, string>
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

    const tagFilter =
      tag === 'none' ? sql`and join_tag is null`
      : tag ? sql`and join_tag = ${tag.toLowerCase()}`
      : sql``

    // Strip separators/quotes so search behaviour stays stable. The term is a
    // bind parameter. `%`/`_` stay wildcards, and `*` too (an alias of `%`).
    const search = query.trim().replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim()
    let searchFilter = sql``
    if (search) {
      const pattern = `%${search.replace(/\*/g, '%')}%`
      searchFilter = /^-?\d+$/.test(search)
        ? sql`and (name ilike ${pattern} or username ilike ${pattern} or email ilike ${pattern} or telegram_id = ${search}::bigint)`
        : sql`and (name ilike ${pattern} or username ilike ${pattern} or email ilike ${pattern})`
    }

    // Admins see every user, deleted ones included (unless a status filter says otherwise).
    let data: any[]
    let count: number
    try {
      ;[data, [{ count }]] = await Promise.all([
        sql`
          select id, telegram_id, email, google_sub, username, name, age, gender, looking_for, is_active, is_seed,
                 banned_at, paused_at, deleted_at, created_at, last_active, geo_city, geo_country,
                 locale, account_status, join_tag
          from users
          where true ${statusFilter} ${genderFilter} ${tagFilter} ${searchFilter}
          order by created_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`
          select count(*)::int as count from users
          where true ${statusFilter} ${genderFilter} ${tagFilter} ${searchFilter}`,
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
      const [photos, [counts], matchRows, deviceRows, deletionRows] = await Promise.all([
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
        sql<any[]>`
          select device_id, platform, app_version, device_model, os, user_agent,
                 push_token is not null as has_push, push_token_at, first_seen_at, last_seen_at
          from user_devices where user_id = ${id} order by last_seen_at desc limit 50`,
        sql<{ reason: string | null; note: string | null; created_at: string }[]>`
          select reason, note, created_at from account_deletion_reasons
          where user_id = ${id} order by created_at desc, id desc`,
      ])
      const devices = deviceRows.map((d) => ({
        deviceId: d.device_id,
        platform: d.platform,
        appVersion: d.app_version ?? null,
        deviceModel: d.device_model ?? null,
        os: d.os ?? null,
        userAgent: d.user_agent ?? null,
        hasPush: d.has_push,
        pushTokenAt: d.push_token_at ?? null,
        firstSeenAt: d.first_seen_at,
        lastSeenAt: d.last_seen_at,
      }))
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
          referredBy: user.referred_by ?? null,
          photos: (photos ?? []).map((p: any) => p.url),
        },
        counts: { swipesGiven, likesReceived, matches: matches.length, messagesSent },
        matches,
        devices,
        deletionReasons: deletionRows.map((r) => ({ reason: r.reason, note: r.note, createdAt: r.created_at })),
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
    type Paused = { id: string; telegram_id: number | null; allows_write_to_pm: boolean | null; locale: Locale | null }
    let data: Paused | undefined
    try {
      ;[data] = isUuid(id)
        ? await sql<Paused[]>`
            update users set paused_at = ${pausedAt} where id = ${id}
            returning id, telegram_id, allows_write_to_pm, locale`
        : []
    } catch { /* any failure answered 404 before, too */ }
    if (!data) return reply.status(404).send({ error: 'user_not_found' })

    // Pausing for photo review means the user must re-upload from scratch;
    // best-effort by construction, never blocks the pause response.
    if (pausedAt) await deleteAllPhotosForUser(id)

    // Warn the user only when pausing (not on resume): push first, else a bot
    // DM if DMs are not explicitly declined (checked inside).
    if (pausedAt) {
      notifyUserPaused(data).catch((err) =>
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

  // Send a one-off message to a single user. Text goes push-first (bot DM
  // fallback); forward is bot-only. Admin override: reaches opted-out and
  // paused/banned users; seed/fake users with no real Telegram chat and no push
  // token are rejected.
  app.post('/users/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { kind?: string; text?: string; title?: string; link?: string; button?: unknown }
    const isForward = body.kind === 'forward'

    // Validate the payload (per kind) before we touch the DB, so a bad request
    // never does a pointless lookup.
    let forwardTo: { chatId: string | number; messageId: number } | null = null
    let text = ''
    let button: MessageButton | undefined
    if (isForward) {
      forwardTo = parseChannelMessageLink(body.link ?? '')
      if (!forwardTo) return reply.status(400).send({ error: 'invalid_link' })
    } else {
      text = (body.text ?? '').trim()
      if (!text) return reply.status(400).send({ error: 'empty_message' })
      if (text.length > 4096) return reply.status(400).send({ error: 'message_too_long' })
      const btn = validateButton(body.button)
      if (!btn.ok) return reply.status(400).send({ error: btn.error })
      button = btn.button
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : ''

    let user: { id: string; telegram_id: number | null; is_seed: boolean; locale: string | null } | undefined
    try {
      ;[user] = isUuid(id)
        ? await sql<{ id: string; telegram_id: number | null; is_seed: boolean; locale: string | null }[]>`
            select id, telegram_id, is_seed, locale from users where id = ${id}`
        : []
    } catch (err) {
      req.log.error({ err }, 'user lookup failed')
      return reply.status(500).send({ error: 'user_fetch_failed' })
    }
    if (!user) return reply.status(404).send({ error: 'user_not_found' })
    // Fakes (negative) and website-only users (null telegram_id) can't get bot DMs.
    const telegramId = user.telegram_id
    const telegramOk = !user.is_seed && telegramId !== null && telegramId > 0

    try {
      if (forwardTo) {
        if (!telegramOk) return reply.status(400).send({ error: 'not_messageable' })
        await forwardBroadcastMessage(telegramId as number, forwardTo.chatId, forwardTo.messageId)
        return { ok: true }
      }
      let hasToken = false
      if (isPushConfigured() && !isStandby()) {
        const rows = await sql`select 1 from user_devices where user_id = ${user.id} and push_token is not null limit 1`
        hasToken = rows.length > 0
      }
      if (!telegramOk && !hasToken) return reply.status(400).send({ error: 'not_messageable' })
      // allows_write_to_pm null: the admin override ignores the user's DM opt-out.
      const via = await notifyUserText(
        { id: user.id, telegram_id: telegramOk ? telegramId : null, allows_write_to_pm: null, locale: user.locale },
        { type: 'admin_message', title, text, button },
      )
      if (via === 'none') return reply.status(400).send({ error: 'not_messageable' })
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

  // Test push to a single user's registered devices (Android dev testing).
  app.post('/users/:id/push', async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { title?: unknown; body?: unknown }
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const text = typeof b.body === 'string' ? b.body.trim() : ''
    if (!title || title.length > 100 || !text || text.length > 500) {
      return reply.status(400).send({ error: 'invalid_push' })
    }
    if (isStandby()) return reply.status(503).send({ error: 'standby' })
    if (!isPushConfigured()) return reply.status(503).send({ error: 'push_not_configured' })

    let rows: { id: string; has_token: boolean }[] = []
    try {
      rows = isUuid(id)
        ? await sql<{ id: string; has_token: boolean }[]>`
            select u.id, exists (select 1 from user_devices d where d.user_id = u.id and d.push_token is not null) as has_token
            from users u where u.id = ${id}`
        : []
    } catch (err) {
      req.log.error({ err }, 'user lookup failed')
      return reply.status(500).send({ error: 'user_fetch_failed' })
    }
    if (!rows[0]) return reply.status(404).send({ error: 'user_not_found' })
    if (!rows[0].has_token) return reply.status(409).send({ error: 'no_push_device' })
    try {
      const r = await sendPushToUser(id, { type: 'test', title, body: text, link: appLink() })
      return { sent: r.sent, dead: r.dead, failed: r.failed }
    } catch (err) {
      req.log.error({ err }, 'admin test push failed')
      return reply.status(502).send({ error: 'send_failed' })
    }
  })
}

export { GENDERS, LOOKING }
