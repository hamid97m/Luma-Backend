import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

const BATCH_SIZE = 10
const PASS_RECYCLE_MS = 24 * 60 * 60 * 1000

export async function discoveryRoutes(app: FastifyInstance) {
  app.get('/discovery', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    // Get viewer's preference
    const { data: viewer } = await db
      .from('users')
      .select('looking_for')
      .eq('id', req.userId)
      .single()

    if (!viewer) return reply.status(404).send({ error: 'user_not_found' })

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

    // Map looking_for to gender filter — 'both' means no gender filter
    const genderFilter =
      viewer.looking_for === 'men' ? 'man' :
      viewer.looking_for === 'women' ? 'woman' : null

    // Build base query up to is_active filter
    const baseQuery = db
      .from('users')
      .select('id, name, age, bio, telegram_id, user_photos(id, url, position)')
      .eq('is_active', true)

    // Apply gender filter before exclude and ordering
    const filteredQuery = genderFilter
      ? (baseQuery as any).eq('gender', genderFilter)
      : baseQuery

    const { data: profiles, error } = await (filteredQuery as any)
      .not('id', 'in', `(${excludeIds.join(',')})`)
      .order('last_active', { ascending: false })
      .limit(BATCH_SIZE)

    if (error) return reply.status(500).send({ error: 'discovery_failed' })

    const formatted = (profiles ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      bio: p.bio,
      telegramId: p.telegram_id,
      photos: (p.user_photos as any[])
        .sort((a, b) => a.position - b.position)
        .map((ph: any) => ph.url),
    }))

    return { profiles: formatted, exhausted: formatted.length === 0 }
  })
}
