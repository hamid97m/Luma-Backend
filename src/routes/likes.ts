import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { isPremiumActive } from '../premium/service.js'
import { getIncomingLikers } from '../likes/service.js'

/** Is the premium gate active for this viewer right now? (toggle on AND not premium) */
async function gateActiveFor(userId: string): Promise<boolean> {
  const { data: cfg } = await db.from('premium_config').select('premium_enabled').eq('id', true).single()
  if (cfg?.premium_enabled !== true) return false
  const { data: me } = await db.from('users').select('premium_until').eq('id', userId).single()
  return !isPremiumActive(me?.premium_until ?? null)
}

export async function likesRoutes(app: FastifyInstance) {
  app.get('/likes', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [likers, gateActive] = await Promise.all([
      getIncomingLikers(req.userId),
      gateActiveFor(req.userId),
    ])

    const visibleLikers = likers.filter((l) => !(gateActive && l.gender === 'woman'))
    const lockedCount = likers.length - visibleLikers.length

    // Hydrate photos only for visible likers.
    let photosByUser = new Map<string, string[]>()
    if (visibleLikers.length > 0) {
      const { data: photoRows } = await db
        .from('user_photos')
        .select('user_id, url, position')
        .in('user_id', visibleLikers.map((l) => l.id))
        .order('position', { ascending: true })
      for (const p of (photoRows ?? []) as Array<{ user_id: string; url: string }>) {
        const arr = photosByUser.get(p.user_id) ?? []
        arr.push(p.url)
        photosByUser.set(p.user_id, arr)
      }
    }

    const visible = visibleLikers.map((l) => ({
      id: l.id,
      name: l.name,
      age: l.age,
      bio: l.bio,
      telegramId: l.telegramId,
      photos: photosByUser.get(l.id) ?? [],
      likedAt: l.likedAt,
    }))

    // Mark seen so the badge clears. Fire-and-forget — a failed watermark write
    // only means the badge lingers, not a broken screen.
    db.from('users').update({ likes_seen_at: new Date().toISOString() }).eq('id', req.userId)
      .then(({ error }: { error: unknown }) => { if (error) req.log.warn({ err: error }, 'likes_seen_at update failed') })

    return { visible, lockedCount, premiumRequired: lockedCount > 0 }
  })

  app.get('/likes/unread-count', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [likers, { data: me }] = await Promise.all([
      getIncomingLikers(req.userId),
      db.from('users').select('likes_seen_at').eq('id', req.userId).single(),
    ])
    const seenAt = me?.likes_seen_at ? new Date(me.likes_seen_at).getTime() : 0
    const count = likers.filter((l) => new Date(l.likedAt).getTime() > seenAt).length
    return { count }
  })
}
