import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { isPremiumActive } from '../premium/service.js'
import { getIncomingLikers, getIncomingLiker } from '../likes/service.js'
import { ensureDailyReveal } from '../likes/reveal.js'

async function likersForViewer(userId: string) {
  const reveal = await ensureDailyReveal(userId)
  if (!reveal.applies) return getIncomingLikers(userId)
  // Her one revealed liker is loaded directly: the pick can fall outside the
  // newest-100 window getIncomingLikers returns.
  if (!reveal.swiperId) return []
  const liker = await getIncomingLiker(userId, reveal.swiperId)
  return liker ? [liker] : []
}

/** Is the premium gate active for this viewer right now? (toggle on AND not premium) */
async function gateActiveFor(userId: string): Promise<boolean> {
  // Toggle + viewer expiry in one round trip (was two sequential reads). Read
  // errors were ignored before (toggle unreadable → gate off); keep that.
  try {
    const [row] = await sql<{ premium_enabled: boolean | null; premium_until: string | null }[]>`
      select
        (select premium_enabled from premium_config where id = true) as premium_enabled,
        (select premium_until from users where id = ${userId}) as premium_until`
    if (row?.premium_enabled !== true) return false
    return !isPremiumActive(row.premium_until ?? null)
  } catch {
    return false
  }
}

export async function likesRoutes(app: FastifyInstance) {
  app.get('/likes', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [likers, gateActive] = await Promise.all([
      likersForViewer(req.userId),
      gateActiveFor(req.userId),
    ])

    const visibleLikers = likers.filter((l) => !(gateActive && l.gender === 'woman'))
    const lockedLikers = likers.filter((l) => gateActive && l.gender === 'woman')
    const lockedCount = lockedLikers.length

    // Hydrate photos for all likers. Locked likers only ever expose their first
    // photo URL (rendered blurred client-side) — never their name, id, or any
    // other profile field. NOTE: the URL is the real, unblurred original, so a
    // determined non-premium viewer can retrieve it from the network tab. This
    // is a deliberate product choice (blurred-real-photo teaser); a truly
    // leak-proof version would serve a server-side pre-blurred thumbnail.
    const photosByUser = new Map<string, string[]>()
    const allIds = likers.map((l) => l.id)
    if (allIds.length > 0) {
      // A failed photo read only means tiles without photos (error was ignored before).
      const photoRows = await sql<{ user_id: string; url: string }[]>`
        select user_id, url from user_photos
        where user_id = any(${allIds}::uuid[])
        order by position asc`.catch(() => [] as { user_id: string; url: string }[])
      for (const p of photoRows) {
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
      location: l.location,
      interests: l.interests,
      telegramId: l.telegramId,
      photos: photosByUser.get(l.id) ?? [],
      likedAt: l.likedAt,
      premium: l.premium === true,
    }))

    // Locked likers: ONLY the first photo (for a blurred tile). No identity.
    const locked = lockedLikers.map((l) => ({ photo: photosByUser.get(l.id)?.[0] ?? null }))

    // Mark seen so the badge clears. Fire-and-forget — a failed watermark write
    // only means the badge lingers, not a broken screen.
    sql`update users set likes_seen_at = ${new Date().toISOString()} where id = ${req.userId}`
      .catch((err) => req.log.warn({ err }, 'likes_seen_at update failed'))

    return { visible, locked, lockedCount, premiumRequired: lockedCount > 0 }
  })

  app.get('/likes/unread-count', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [likers, me] = await Promise.all([
      likersForViewer(req.userId),
      // A failed watermark read counted every like as unread before; keep that.
      sql<{ likes_seen_at: string | null }[]>`select likes_seen_at from users where id = ${req.userId}`
        .then(([row]) => row ?? null, () => null),
    ])
    const seenAt = me?.likes_seen_at ? new Date(me.likes_seen_at).getTime() : 0
    const count = likers.filter((l) => new Date(l.likedAt).getTime() > seenAt).length
    return { count }
  })
}
