import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

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
    isActive: u.is_active,
    isSeed: u.is_seed,
    bannedAt: u.banned_at,
    deletedAt: u.deleted_at,
    createdAt: u.created_at,
    lastActive: u.last_active,
  }
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get('/users', async (req, reply) => {
    const { query = '', status = 'all', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    let q: any = db
      .from('users')
      .select(
        'id, telegram_id, username, name, age, gender, is_active, is_seed, banned_at, deleted_at, created_at, last_active',
        { count: 'exact' }
      )

    if (status === 'active') q = q.is('deleted_at', null).is('banned_at', null)
    else if (status === 'banned') q = q.not('banned_at', 'is', null)
    else if (status === 'deleted') q = q.not('deleted_at', 'is', null)
    else if (status === 'seed') q = q.eq('is_seed', true)

    const search = query.trim().replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim()
    if (search) {
      const ors = [`name.ilike.%${search}%`, `username.ilike.%${search}%`]
      if (/^-?\d+$/.test(search)) ors.push(`telegram_id.eq.${search}`)
      q = q.or(ors.join(','))
    }

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'users_fetch_failed' })

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

    const { data: user, error } = await db
      .from('users')
      .insert({
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
        is_seed: true,
        is_active: true,
      })
      .select('id')
      .single()

    if (error || !user) return reply.status(500).send({ error: 'create_failed' })

    if (photos.length) {
      const { error: photoErr } = await db
        .from('user_photos')
        .insert(photos.map((url, i) => ({ user_id: user.id, url, position: i })))
      if (photoErr) req.log.warn({ err: photoErr }, 'failed to insert seed photos')
    }

    return reply.status(201).send({ id: user.id })
  })

  app.get('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    const { data: user } = await db.from('users').select('*').eq('id', id).single()
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    try {
      const { data: photos, error: photosErr } = await db
        .from('user_photos')
        .select('url, position')
        .eq('user_id', id)
        .order('position', { ascending: true })
      if (photosErr) throw new Error('user detail photos failed')

      const countOf = async (table: string, refine: (q: any) => any): Promise<number> => {
        const { count, error } = await refine(db.from(table).select('id', { count: 'exact', head: true }))
        if (error) throw new Error(`user detail count failed: ${table}`)
        return count ?? 0
      }

      const [swipesGiven, likesReceived, messagesSent] = await Promise.all([
        countOf('swipes', (q) => q.eq('swiper_id', id)),
        countOf('swipes', (q) => q.eq('swiped_id', id).eq('direction', 'like')),
        countOf('messages', (q) => q.eq('sender_id', id)),
      ])

      const { data: matchRows, error: matchesErr } = await db
        .from('matches')
        .select(`
          id, created_at, user1_id, user2_id,
          user1:users!matches_user1_id_fkey(id, name, user_photos(url, position)),
          user2:users!matches_user2_id_fkey(id, name, user_photos(url, position))
        `)
        .or(`user1_id.eq.${id},user2_id.eq.${id}`)
        .order('created_at', { ascending: false })
      if (matchesErr) throw new Error('user detail matches failed')

      const matches = (matchRows ?? []).map((row: any) => {
        const other = row.user1_id === id ? row.user2 : row.user1
        const photo =
          (other?.user_photos ?? [])
            .slice()
            .sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
        return {
          matchId: row.id,
          matchedAt: row.created_at,
          user: { id: other?.id ?? null, name: other?.name ?? '', photo },
        }
      })

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

  const setBanned = async (id: string, bannedAt: string | null, reply: any) => {
    const { data, error } = await db
      .from('users')
      .update({ banned_at: bannedAt })
      .eq('id', id)
      .select('id')
      .single()
    if (error || !data) return reply.status(404).send({ error: 'user_not_found' })
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
}

export { GENDERS, LOOKING }
