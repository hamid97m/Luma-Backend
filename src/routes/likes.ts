import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { isPremiumActive } from '../premium/service.js'
import { getIncomingLikers, getIncomingLiker, getLikerQueue, type IncomingLiker } from '../likes/service.js'
import { ensureDailyReveal } from '../likes/reveal.js'
import { getLikesAccess, grantFriendLikeDays, LIKES_DAYS_PER_FRIEND } from '../likes/unlock.js'
import { blurredPhotoUrl, decodeBlurToken, renderBlurred } from '../likes/blurredPhoto.js'

/** Blurred tiles she gets; the count covers the rest. */
const TEASER_TILES = 6

interface ViewerLikes {
  likers: IncomingLiker[]
  /** Waiting likers a woman can't open yet (never serialized as is). */
  locked: IncomingLiker[]
  /** Sees everyone, so the premium woman-liker gate doesn't apply either. */
  unlocked: boolean
  unlockedUntil: string | null
}

async function likersForViewer(userId: string): Promise<ViewerLikes> {
  const access = await getLikesAccess(userId)
  if (access.unlocked) {
    return { likers: await getLikerQueue(userId), locked: [], unlocked: true, unlockedUntil: access.unlockedUntil }
  }
  const reveal = await ensureDailyReveal(userId)
  const base = { locked: [], unlocked: false, unlockedUntil: null }
  if (!reveal.applies) return { ...base, likers: await getIncomingLikers(userId) }
  // Her one revealed liker is loaded directly: the pick can fall outside the
  // newest-100 window the lists return.
  const [liker, queue] = await Promise.all([
    reveal.swiperId ? getIncomingLiker(userId, reveal.swiperId) : null,
    // The teaser is a bonus: without it she still gets today's like.
    getLikerQueue(userId).catch((err) => {
      console.error('likes: queue read failed', err)
      return [] as IncomingLiker[]
    }),
  ])
  return { ...base, likers: liker ? [liker] : [], locked: queue.filter((l) => l.id !== reveal.swiperId) }
}

/** Which unlock paths are on; both off hides the locked section. */
async function unlockPaths(): Promise<{ invite: boolean; premium: boolean }> {
  try {
    const [row] = await sql<{ invite: boolean | null; premium: boolean | null }[]>`
      select (select enabled and audience <> 'men' from referral_config where id = true) as invite,
             (select premium_enabled from premium_config where id = true) as premium`
    return { invite: row?.invite === true, premium: row?.premium === true }
  } catch {
    return { invite: false, premium: false }
  }
}

async function queueTeaser(locked: IncomingLiker[]) {
  if (locked.length === 0) return null
  const paths = await unlockPaths()
  if (!paths.invite && !paths.premium) return null
  const ids = locked.slice(0, TEASER_TILES).map((l) => l.id)
  const rows = await sql<{ user_id: string; url: string }[]>`
    select distinct on (user_id) user_id, url from user_photos
    where user_id = any(${ids}::uuid[])
    order by user_id, position asc`.catch(() => [] as { user_id: string; url: string }[])
  const urls = new Map(rows.map((r) => [r.user_id, r.url]))
  return {
    lockedCount: locked.length,
    photos: ids.map((id) => (urls.has(id) ? blurredPhotoUrl(urls.get(id) as string) : null)),
    inviteEnabled: paths.invite,
    premiumEnabled: paths.premium,
    daysPerFriend: LIKES_DAYS_PER_FRIEND,
  }
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

    // Catch-up for friends who became countable since (e.g. photo check was slow).
    await grantFriendLikeDays(req.userId)

    const [viewerLikes, premiumGate] = await Promise.all([
      likersForViewer(req.userId),
      gateActiveFor(req.userId),
    ])
    const { likers, unlocked, unlockedUntil } = viewerLikes
    const gateActive = premiumGate && !unlocked
    const queue = await queueTeaser(viewerLikes.locked)

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

    return { visible, locked, lockedCount, premiumRequired: lockedCount > 0, queue, unlockedUntil }
  })

  // Wildcard: the token is longer than Fastify's param limit (see routes/media.ts).
  app.get<{ Params: { '*': string } }>(
    '/likes/blurred/*',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const path = decodeBlurToken(req.params['*'])
      const image = path && (await renderBlurred(path))
      if (!image) return reply.status(404).send({ error: 'not_found' })
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=3600').send(image)
    },
  )

  app.get('/likes/unread-count', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [{ likers }, me] = await Promise.all([
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
