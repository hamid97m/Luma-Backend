import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { interleaveBatch, shuffle, isSameCity, orderByProximity } from '../discoveryRanking.js'
import { getSwipeLimitStatus } from '../premium/swipeLimit.js'
import { getDirectChatStatus } from '../premium/directChatLimit.js'
import { isPremiumActive } from '../premium/service.js'
import { hiddenIncomingLikerIds } from '../likes/reveal.js'

const BATCH_SIZE = 10
const MAX_LIKER_SLOTS = 4
// Which batch slots likers get. This only controls whether likers make it
// *into* the 10-profile batch (they shouldn't be crowded out) — the final
// batch is re-ordered by proximity, so it does not fix their display order.
const LIKER_POSITIONS = [0, 1, 2, 3]
// Fetch more than we show so the per-request shuffle varies *which* profiles
// surface across refreshes, not just their order. Ordered by last_active first,
// so the pool still favours recently-active people before shuffling.
const LIKER_POOL = 20
const FILLER_POOL = BATCH_SIZE * 2
const PASS_RECYCLE_MS = 9 * 24 * 60 * 60 * 1000
// Cap the id-list sent to the liker-profiles query; the newest likes are
// not preferred here — any 500 likers is plenty to fill 4 slots.
const MAX_LIKER_IDS = 500
const SWIPE_PAGE = 1000
// Above this many hidden ids, keep them out of the .not('id','in', …) URL and
// filter the returned rows instead.
const MAX_HIDDEN_IN_URL = 50

// user_photos!inner makes the embed an INNER JOIN, so users with zero photos
// are excluded from discovery entirely — an incomplete/abandoned profile (no
// photo uploaded) must never surface as a blank card. geo_city/geo_country/
// locale are ranking-only and are deliberately left out of the response below.
const PROFILE_COLUMNS =
  'id, name, age, bio, telegram_id, interests, location, geo_city, geo_country, locale, premium_until, user_photos!inner(id, url, position)'

export async function discoveryRoutes(app: FastifyInstance) {
  app.get('/discovery', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    // Get viewer's preference, gender, city/country and app language
    const { data: viewer } = await db
      .from('users')
      .select('looking_for, gender, location, geo_city, geo_country, locale')
      .eq('id', req.userId)
      .single()

    if (!viewer) return reply.status(404).send({ error: 'user_not_found' })

    const swipeLimit = await getSwipeLimitStatus(req.userId)
    const directChat = await getDirectChatStatus(req.userId)

    const recycleTime = new Date(Date.now() - PASS_RECYCLE_MS).toISOString()

    // Swipes to exclude: all likes + recent passes (passes older than 9 days are recycled)
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

    // Everyone who already liked the viewer (uses idx_swipes_match_check). Paged
    // so an old liker past PostgREST's row cap can't slip into discovery.
    const likerSwiperIds: string[] = []
    for (let from = 0; ; from += SWIPE_PAGE) {
      const { data, error: likersErr } = await db
        .from('swipes')
        .select('swiper_id')
        .eq('swiped_id', req.userId)
        .eq('direction', 'like')
        .order('swiper_id', { ascending: true })
        .range(from, from + SWIPE_PAGE - 1)
      if (likersErr) return reply.status(500).send({ error: 'discovery_failed' })
      const page = (data ?? []) as Array<{ swiper_id: string }>
      likerSwiperIds.push(...page.map((s) => s.swiper_id))
      if (page.length < SWIPE_PAGE) break
    }

    // A reveal failure must not 500 the feed, and must not show her every like:
    // fail closed and treat every liker as hidden (tier 1 gets nobody).
    let hiddenLikers: string[]
    try {
      hiddenLikers = await hiddenIncomingLikerIds(req.userId)
    } catch (err) {
      console.error('discovery: hiddenIncomingLikerIds failed; hiding every liker', err)
      hiddenLikers = likerSwiperIds
    }
    const hiddenSet = new Set(hiddenLikers)

    const excludeIds = [
      req.userId,
      ...(recentSwipes?.map((s: { swiped_id: string }) => s.swiped_id) ?? []),
      ...blockedIds,
    ]
    // Hidden likers join the .not() list only while it stays short; otherwise
    // they are dropped from the returned rows instead (see dropHidden).
    const notIdsBase = hiddenLikers.length <= MAX_HIDDEN_IN_URL ? [...excludeIds, ...hiddenLikers] : excludeIds
    const dropHidden = (rows: any[] | null | undefined): any[] => (rows ?? []).filter((p: any) => !hiddenSet.has(p.id))
    const excluded = new Set([...excludeIds, ...hiddenLikers])

    // Map looking_for to gender filter — 'both'/'everyone' means no gender filter
    const genderFilter =
      viewer.looking_for === 'men' ? 'man' :
      viewer.looking_for === 'women' ? 'woman' : null

    // Reciprocal filter: only surface candidates whose own looking_for includes
    // the viewer's gender. Without this a candidate who isn't interested in the
    // viewer (e.g. a man who only seeks women) still shows up in the viewer's
    // feed — most visibly when the viewer looks for 'everyone'/'both' and gets
    // no viewer-side gender filter at all. 'everyone'/'both' candidates match
    // any viewer gender.
    const interestedIn =
      viewer.gender === 'man' ? ['men', 'everyone', 'both'] :
      viewer.gender === 'woman' ? ['women', 'everyone', 'both'] : null

    // includeSeed=false (default) excludes fake/seed profiles so real people are
    // ranked and surfaced first. Seeds are only pulled in as a tail filler once
    // real candidates run low (see the seed top-up below).
    const profileQuery = (includeSeed = false) => {
      let q: any = db
        .from('users')
        .select(PROFILE_COLUMNS)
        .eq('is_active', true)
        .is('banned_at', null)
        .is('paused_at', null)
        // Explicit soft-delete guard. Deleting also sets is_active=false today,
        // so this looks redundant — but discovery must never depend on that
        // coincidence (e.g. a future re-activation path that forgets deleted_at).
        .is('deleted_at', null)
        // age > 0 is the canonical "profile setup complete" signal (see
        // profile.ts / auth.ts). New users start at age 0 with is_active
        // defaulting true, so without this an incomplete profile (age 0)
        // would surface as a blank/half-empty card.
        .gt('age', 0)
      if (!includeSeed) q = q.eq('is_seed', false)
      if (genderFilter) q = q.eq('gender', genderFilter)
      if (interestedIn) q = q.in('looking_for', interestedIn)
      return q
    }

    // Tier 1: people who already liked the viewer (minus the hidden ones)
    const likerIds = likerSwiperIds
      .filter((id: string) => !excluded.has(id))
      .slice(0, MAX_LIKER_IDS)

    let likers: any[] = []
    if (likerIds.length > 0) {
      const { data, error } = await profileQuery()
        .in('id', likerIds)
        .order('last_active', { ascending: false })
        .limit(LIKER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      likers = shuffle(dropHidden(data)).slice(0, MAX_LIKER_SLOTS)
    }

    // Tier 2: same city. Ranking uses only the hidden normalized geo_city /
    // geo_country, never the typed location — an unresolved viewer skips it.
    const likerPickedIds = [...notIdsBase, ...likers.map((p: any) => p.id)]
    const geoCountry: string | null = viewer.geo_country ?? null
    const geoCity: string | null = geoCountry ? viewer.geo_city ?? null : null
    let sameCity: any[] = []
    if (geoCity) {
      const { data, error } = await profileQuery()
        .eq('geo_country', geoCountry)
        .eq('geo_city', geoCity)
        .not('id', 'in', `(${likerPickedIds.join(',')})`)
        .order('last_active', { ascending: false })
        .limit(FILLER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      sameCity = shuffle(dropHidden(data))
    }

    // Tier 3: same country (only when the viewer's location is resolved)
    const cityPickedIds = [...likerPickedIds, ...sameCity.map((p: any) => p.id)]
    let sameCountry: any[] = []
    if (geoCountry) {
      const { data, error } = await profileQuery()
        .eq('geo_country', geoCountry)
        .not('id', 'in', `(${cityPickedIds.join(',')})`)
        .order('last_active', { ascending: false })
        .limit(FILLER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      sameCountry = shuffle(dropHidden(data))
    }

    // Tier 4: same app language (users.locale), when the viewer has one
    const countryPickedIds = [...cityPickedIds, ...sameCountry.map((p: any) => p.id)]
    let sameLanguage: any[] = []
    if (viewer.locale) {
      const { data, error } = await profileQuery()
        .eq('locale', viewer.locale)
        .not('id', 'in', `(${countryPickedIds.join(',')})`)
        .order('last_active', { ascending: false })
        .limit(FILLER_POOL)
      if (error) return reply.status(500).send({ error: 'discovery_failed' })
      sameLanguage = shuffle(dropHidden(data))
    }

    // Tier 5: everyone else, most recently active first
    const allPickedIds = [...countryPickedIds, ...sameLanguage.map((p: any) => p.id)]
    const { data: rest, error } = await profileQuery()
      .not('id', 'in', `(${allPickedIds.join(',')})`)
      .order('last_active', { ascending: false })
      .limit(FILLER_POOL)

    if (error) return reply.status(500).send({ error: 'discovery_failed' })

    // Build the batch (likers boosted in so they're not crowded out), then show
    // it closest-first: same city, same country, same language, rest — random
    // within each tier, likers placed in their own tier rather than pinned.
    const merged = orderByProximity(
      viewer,
      interleaveBatch(likers, [sameCity, sameCountry, sameLanguage, shuffle(dropHidden(rest))], BATCH_SIZE, LIKER_POSITIONS),
    )

    // Seed/fake profiles come last: only when real candidates can't fill the
    // batch do we top up with seeds, appended at the tail (never shuffled in
    // among real profiles). Since swiped users are excluded each request, real
    // people deplete over time and seeds only surface once they're exhausted.
    let batch = merged
    if (batch.length < BATCH_SIZE) {
      const seedExcludeIds = [...notIdsBase, ...batch.map((p: any) => p.id)]
      const { data: seeds, error: seedErr } = await profileQuery(true)
        .eq('is_seed', true)
        .not('id', 'in', `(${seedExcludeIds.join(',')})`)
        .order('last_active', { ascending: false })
        .limit(BATCH_SIZE - batch.length)
      if (seedErr) return reply.status(500).send({ error: 'discovery_failed' })
      batch = [...batch, ...shuffle(dropHidden(seeds))]
    }

    const formatted = batch.map((p: any) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      bio: p.bio,
      telegramId: p.telegram_id,
      interests: p.interests ?? [],
      location: p.location ?? null,
      // Boolean only — the expiry timestamp stays server-side.
      premium: isPremiumActive(p.premium_until ?? null),
      // "همین نزدیکی" badge only when both resolve to the same normalized city.
      nearby: isSameCity(viewer, p),
      photos: (p.user_photos as any[])
        .sort((a, b) => a.position - b.position)
        .map((ph: any) => ph.url),
    }))

    return { profiles: formatted, exhausted: formatted.length === 0, swipeLimit, directChat }
  })
}
