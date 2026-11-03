import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { interleaveBatch, shuffle, isSameCity, orderByProximity } from '../discoveryRanking.js'
import { getSwipeLimitStatus } from '../premium/swipeLimit.js'
import { getDirectChatStatus } from '../premium/directChatLimit.js'
import { isPremiumActive } from '../premium/service.js'
import { hiddenIncomingLikerIds } from '../likes/reveal.js'
import { effectiveLocale } from '../i18n/index.js'

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

type Tier = 'liker' | 'city' | 'country' | 'language' | 'rest' | 'seed'

type Candidate = {
  tier: Tier
  /** Position by last_active within the seed tier (1 = most recent); null elsewhere. */
  seed_rank: number | null
  id: string
  name: string
  age: number
  bio: string | null
  telegram_id: number
  interests: string[] | null
  location: string | null
  // Ranking-only: deliberately left out of the response below.
  geo_city: string | null
  geo_country: string | null
  locale: string | null
  premium_until: string | null
  user_photos: Array<{ id: string; url: string; position: number }>
}

type ViewerRow = {
  looking_for: string | null
  gender: string | null
  location: string | null
  geo_city: string | null
  geo_country: string | null
  locale: string | null
}

export async function discoveryRoutes(app: FastifyInstance) {
  app.get('/discovery', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const userId = req.userId
    const recycleTime = new Date(Date.now() - PASS_RECYCLE_MS).toISOString()

    // These reads are independent of each other, so they run concurrently.
    // Swipes, blocks and incoming likes are no longer fetched as id lists — the
    // candidate query below applies them as NOT EXISTS / EXISTS filters itself.
    const [viewer, swipeLimit, directChat, hiddenRead] = await Promise.all([
      // Viewer's preference, gender, city/country and app language. A read error
      // answers 404 (treated as a missing viewer).
      sql<ViewerRow[]>`
        select looking_for, gender, location, geo_city, geo_country, locale
        from users where id = ${userId}`
        .then(([row]) => row ?? null, () => null),
      getSwipeLimitStatus(userId),
      getDirectChatStatus(userId),
      hiddenIncomingLikerIds(userId).then(
        (ids) => ({ ids, failed: false }),
        (err) => {
          console.error('discovery: hiddenIncomingLikerIds failed', err)
          return { ids: [] as string[], failed: true }
        },
      ),
    ])

    if (!viewer) return reply.status(404).send({ error: 'user_not_found' })

    // A reveal failure must not 500 the feed. For a woman, fail closed: treat every
    // liker as hidden so she is never shown all her likes (tier 1 gets nobody). A
    // man has no reveal gate, so he keeps seeing his likers.
    const hideAllLikers = hiddenRead.failed && viewer.gender === 'woman'
    const hiddenLikers: string[] = hiddenRead.failed ? [] : hiddenRead.ids

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

    // Tier conditions. Ranking uses only the hidden normalized geo_city /
    // geo_country, never the typed location — an unresolved viewer skips them.
    const geoCountry: string | null = viewer.geo_country ?? null
    const geoCity: string | null = geoCountry ? viewer.geo_city ?? null : null
    const cityCond = geoCity ? sql`geo_country = ${geoCountry} and geo_city = ${geoCity}` : sql`false`
    const countryCond = geoCountry ? sql`geo_country = ${geoCountry}` : sql`false`
    const languageCond = viewer.locale ? sql`locale = ${viewer.locale}` : sql`false`

    // Seeds only fill a deck in the viewer's language. Unset locale is Persian,
    // so Iranian fakes (no locale of their own) reach Persian viewers only.
    const seedLanguage = effectiveLocale(viewer.locale)
    const seedLocaleCond = seedLanguage === 'fa'
      ? sql`(locale = 'fa' or locale is null)`
      : sql`locale = ${seedLanguage}`

    // Every tier in ONE statement (the old code ran up to six sequential reads:
    // likers, city, country, language, rest, seed top-up). Each tier keeps its
    // old definition exactly:
    //  pool     — eligible profiles. Signup state: only active accounts (preparing =
    //             opened the app but has not finished). Explicit soft-delete guard
    //             (deleting also sets is_active=false today, but discovery must never
    //             depend on that coincidence). age > 0 backstop. At least one photo
    //             (was the user_photos!inner embed): a photo-less profile must never
    //             surface as a blank card. Excludes the viewer, everyone she liked or
    //             passed within 9 days (older passes recycle), blocks either way, and
    //             hidden likers.
    //  likers   — tier 1: people who already liked the viewer; top LIKER_POOL by
    //             last_active, MAX_LIKER_SLOTS of them at random.
    //  city / country / language / rest — tiers 2-5, each the FILLER_POOL most
    //             recently active real profiles not picked by an earlier tier.
    //  seeds    — fake/seed profiles in the viewer's language; only used as a
    //             tail top-up below, so real people are ranked and surfaced first.
    let rows: Candidate[]
    try {
      rows = await sql<Candidate[]>`
        with pool as (
          select u.id, u.name, u.age, u.bio, u.telegram_id, u.interests, u.location,
                 u.geo_city, u.geo_country, u.locale, u.premium_until, u.last_active, u.is_seed
          from users u
          where u.is_active = true
            and u.account_status = 'active'
            and u.banned_at is null
            and u.paused_at is null
            and u.deleted_at is null
            and u.age > 0
            and exists (select 1 from user_photos ph where ph.user_id = u.id)
            ${genderFilter ? sql`and u.gender = ${genderFilter}` : sql``}
            ${interestedIn ? sql`and u.looking_for = any(${interestedIn}::looking_type[])` : sql``}
            and u.id <> ${userId}
            and not exists (
              select 1 from swipes s
              where s.swiper_id = ${userId} and s.swiped_id = u.id
                and (s.direction = 'like' or (s.direction = 'pass' and s.created_at > ${recycleTime})))
            and not exists (
              select 1 from blocks b
              where (b.blocker_id = ${userId} and b.blocked_id = u.id)
                 or (b.blocker_id = u.id and b.blocked_id = ${userId}))
            and u.id <> all(${hiddenLikers}::uuid[])
            ${hideAllLikers
              ? sql`and not exists (
                  select 1 from swipes h
                  where h.swiper_id = u.id and h.swiped_id = ${userId} and h.direction = 'like')`
              : sql``}
        ),
        likers as materialized (
          select * from (
            select p.* from pool p
            where not p.is_seed
              and exists (
                select 1 from swipes l
                where l.swiper_id = p.id and l.swiped_id = ${userId} and l.direction = 'like')
            order by p.last_active desc
            limit ${LIKER_POOL}
          ) top
          order by random()
          limit ${MAX_LIKER_SLOTS}
        ),
        fill as materialized (
          select * from pool where not is_seed and id not in (select id from likers)
        ),
        city as materialized (
          select * from fill where ${cityCond}
          order by last_active desc limit ${FILLER_POOL}
        ),
        country as materialized (
          select * from fill where ${countryCond} and id not in (select id from city)
          order by last_active desc limit ${FILLER_POOL}
        ),
        language as materialized (
          select * from fill where ${languageCond}
            and id not in (select id from city) and id not in (select id from country)
          order by last_active desc limit ${FILLER_POOL}
        ),
        rest as materialized (
          select * from fill
          where id not in (select id from city)
            and id not in (select id from country)
            and id not in (select id from language)
          order by last_active desc limit ${FILLER_POOL}
        ),
        seeds as (
          select pool.*, row_number() over (order by last_active desc) as seed_rank
          from pool where is_seed and ${seedLocaleCond}
          order by last_active desc limit ${BATCH_SIZE}
        ),
        picked as (
                    select 'liker' as tier, null::bigint as seed_rank, * from likers
          union all select 'city', null, * from city
          union all select 'country', null, * from country
          union all select 'language', null, * from language
          union all select 'rest', null, * from rest
          union all select 'seed', seed_rank, id, name, age, bio, telegram_id, interests, location,
                           geo_city, geo_country, locale, premium_until, last_active, is_seed
                    from seeds
        )
        select t.tier, t.seed_rank, t.id, t.name, t.age, t.bio, t.telegram_id, t.interests,
               t.location, t.geo_city, t.geo_country, t.locale, t.premium_until,
               coalesce((
                 select json_agg(json_build_object('id', ph.id, 'url', ph.url, 'position', ph.position))
                 from user_photos ph where ph.user_id = t.id
               ), '[]') as user_photos
        from picked t`
    } catch (err) {
      req.log.error({ err }, 'discovery query failed')
      return reply.status(500).send({ error: 'discovery_failed' })
    }

    const tier = (name: Tier) => rows.filter((r) => r.tier === name)
    const likers = shuffle(tier('liker'))
    const sameCity = shuffle(tier('city'))
    const sameCountry = shuffle(tier('country'))
    const sameLanguage = shuffle(tier('language'))
    const rest = shuffle(tier('rest'))

    // Build the batch (likers boosted in so they're not crowded out), then show
    // it closest-first: same city, same country, same language, rest — random
    // within each tier, likers placed in their own tier rather than pinned.
    const merged = orderByProximity(
      viewer,
      interleaveBatch(likers, [sameCity, sameCountry, sameLanguage, rest], BATCH_SIZE, LIKER_POSITIONS),
    )

    // Seed/fake profiles come last: only when real candidates can't fill the
    // batch do we top up with seeds — the most recently active ones — appended at
    // the tail (never shuffled in among real profiles). Since swiped users are
    // excluded each request, real people deplete over time and seeds only
    // surface once they're exhausted.
    let batch = merged
    if (batch.length < BATCH_SIZE) {
      const seeds = tier('seed')
        .sort((a, b) => Number(a.seed_rank) - Number(b.seed_rank))
        .slice(0, BATCH_SIZE - batch.length)
      batch = [...batch, ...shuffle(seeds)]
    }

    const formatted = batch.map((p) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      bio: p.bio,
      interests: p.interests ?? [],
      location: p.location ?? null,
      // Boolean only — the expiry timestamp stays server-side.
      premium: isPremiumActive(p.premium_until ?? null),
      // "همین نزدیکی" badge only when both resolve to the same normalized city.
      nearby: isSameCity(viewer, p),
      photos: [...p.user_photos]
        .sort((a, b) => a.position - b.position)
        .map((ph) => ph.url),
    }))

    return { profiles: formatted, exhausted: formatted.length === 0, swipeLimit, directChat }
  })
}
