import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { interleaveBatch, escapeIlike, shuffle } from '../discoveryRanking.js'
import { getSwipeLimitStatus } from '../premium/swipeLimit.js'

const BATCH_SIZE = 10
const MAX_LIKER_SLOTS = 4
// Likers occupy the first slots of the batch (shuffled among themselves).
const LIKER_POSITIONS = [0, 1, 2, 3]
// Fetch more than we show so the per-request shuffle varies *which* profiles
// surface across refreshes, not just their order. Ordered by last_active first,
// so the pool still favours recently-active people before shuffling.
const LIKER_POOL = 20
const FILLER_POOL = BATCH_SIZE * 2
const PASS_RECYCLE_MS = 24 * 60 * 60 * 1000
// Cap the id-list sent to the liker-profiles query; the newest likes are
// not preferred here — any 500 likers is plenty to fill 4 slots.
const MAX_LIKER_IDS = 500

const PROFILE_COLUMNS =
  'id, name, age, bio, telegram_id, interests, location, user_photos(id, url, position)'

export async function discoveryRoutes(app: FastifyInstance) {
  app.get('/discovery', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    // Get viewer's preference and city
    const { data: viewer } = await db
      .from('users')
      .select('looking_for, location')
      .eq('id', req.userId)
      .single()

    if (!viewer) return reply.status(404).send({ error: 'user_not_found' })

    const swipeLimit = await getSwipeLimitStatus(req.userId)

    const recycleTime = new Date(Date.now() - PASS_RECYCLE_MS).toISOString()

    // Swipes to exclude: all likes + recent passes (passes older than 24h are recycled)
    const { data: recentSwipes, error: swipesErr } = await db
      .from('swipes')
      .select('swiped_id')
      .eq('swiper_id', req.userId)
      .or(`direction.eq.like,and(direction.eq.pass,created_at.gt.${recycleTime})`)

    if (swipesErr) return reply.status(500).send({ error: 'discovery_failed' })

    const { data: blocks, error: blocksErr } = await db
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId},blocked_id.eq.${req.userId}`)

    if (blocksErr) return reply.status(500).send({ error: 'discovery_failed' })

    const blockedIds = (blocks ?? []).map((b: { blocker_id: string; blocked_id: string }) =>
      b.blocker_id === req.userId ? b.blocked_id : b.blocker_id
    )

    const excludeIds = [
      req.userId,
      ...(recentSwipes?.map((s: { swiped_id: string }) => s.swiped_id) ?? []),
      ...blockedIds,
    ]
    const excluded = new Set(excludeIds)

    // Map looking_for to gender filter — 'both'/'everyone' means no gender filter
    const genderFilter =
      viewer.looking_for === 'men' ? 'man' :
      viewer.looking_for === 'women' ? 'woman' : null

    const profileQuery = () => {
      const q = db
        .from('users')
        .select(PROFILE_COLUMNS)
        .eq('is_active', true)
        .is('banned_at', null)
      return genderFilter ? (q as any).eq('gender', genderFilter) : (q as any)
    }

    // Tier 1: people who already liked the viewer (uses idx_swipes_match_check)
    const { data: likerSwipes, error: likersErr } = await db
      .from('swipes')
      .select('swiper_id')
      .eq('swiped_id', req.userId)
      .eq('direction', 'like')

    if (likersErr) return reply.status(500).send({ error: 'discovery_failed' })

    const likerIds = (likerSwipes ?? [])
      .map((s: { swiper_id: string }) => s.swiper_id)
      .filter((id: string) => !excluded.has(id))
      .slice(0, MAX_LIKER_IDS)

    let likers: any[] = []
    if (likerIds.length > 0) {
      const { data, error } = await profileQuery()
        .in('id', likerIds)
        .order('last_active', { ascending: false })
        .limit(LIKER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      likers = shuffle(data ?? []).slice(0, MAX_LIKER_SLOTS)
    }

    // Tier 2: same city (case-insensitive exact match on free-text location)
    const likerPickedIds = [...excludeIds, ...likers.map((p: any) => p.id)]
    const city = (viewer.location ?? '').trim()
    let sameCity: any[] = []
    if (city) {
      const { data, error } = await profileQuery()
        .ilike('location', escapeIlike(city))
        .not('id', 'in', `(${likerPickedIds.join(',')})`)
        .order('last_active', { ascending: false })
        .limit(FILLER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      sameCity = shuffle(data ?? [])
    }

    // Tier 3: everyone else, most recently active first
    const allPickedIds = [...likerPickedIds, ...sameCity.map((p: any) => p.id)]
    const { data: rest, error } = await profileQuery()
      .not('id', 'in', `(${allPickedIds.join(',')})`)
      .order('last_active', { ascending: false })
      .limit(FILLER_POOL)

    if (error) return reply.status(500).send({ error: 'discovery_failed' })

    const merged = interleaveBatch(likers, sameCity, shuffle(rest ?? []), BATCH_SIZE, LIKER_POSITIONS)

    const formatted = merged.map((p: any) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      bio: p.bio,
      telegramId: p.telegram_id,
      interests: p.interests ?? [],
      location: p.location ?? null,
      photos: (p.user_photos as any[])
        .sort((a, b) => a.position - b.position)
        .map((ph: any) => ph.url),
    }))

    return { profiles: formatted, exhausted: formatted.length === 0, swipeLimit }
  })
}
