import { sql } from '../db.js'
import { notifyUserLike } from '../notify/userNotify.js'
import { isEligibleRevealLiker, pickRevealCandidate, tehranDate, type RevealCandidate } from './revealPick.js'

export type RevealResult = { applies: false } | { applies: true; swiperId: string | null }

type Viewer = {
  id: string
  gender: string
  is_seed: boolean | null
  geo_city: string | null
  telegram_id: number | null
  allows_write_to_pm: boolean | null
  locale: string | null
}

type StoredReveal = { swiper_id: string; revealed_on: string; notified_at: string | null }

/** Viewer row + her latest reveal, with whether she has acted on that liker and
 *  whether he is still a live incoming liker — one round trip. */
type ViewerState = Viewer & {
  reveal_swiper_id: string | null
  reveal_revealed_on: string | null
  reveal_notified_at: string | null
  /** She has swiped the revealed liker (either direction). */
  acted: boolean | null
  /**
   * The revealed liker is still a live incoming liker. Seed / no-photo do NOT
   * count as gone (an already-shown reveal can stay). Gone = deleted, banned,
   * paused, blocked either way, or matched (any route).
   */
  live: boolean | null
}

// A query error must fail the whole reveal: reading it as "no row" would either
// show her every like (viewer) or send a second like DM (reveal). postgres.js
// throws on every read error, so nothing below swallows one.
async function loadViewerState(userId: string): Promise<ViewerState | null> {
  const [row] = await sql<ViewerState[]>`
    select v.id, v.gender, v.is_seed, v.geo_city, v.telegram_id, v.allows_write_to_pm, v.locale,
           r.swiper_id as reveal_swiper_id, r.revealed_on as reveal_revealed_on,
           r.notified_at as reveal_notified_at,
           case when r.swiper_id is null then null else exists (
             select 1 from swipes s where s.swiper_id = v.id and s.swiped_id = r.swiper_id
           ) end as acted,
           case when r.swiper_id is null then null else (
             exists (
               select 1 from users l
               where l.id = r.swiper_id
                 and l.deleted_at is null and l.banned_at is null and l.paused_at is null)
             and not exists (
               select 1 from blocks b
               where (b.blocker_id = v.id and b.blocked_id = r.swiper_id)
                  or (b.blocker_id = r.swiper_id and b.blocked_id = v.id))
             and not exists (
               select 1 from matches m
               where (m.user1_id = v.id and m.user2_id = r.swiper_id)
                  or (m.user1_id = r.swiper_id and m.user2_id = v.id))
           ) end as live
    from users v
    left join lateral (
      select lr.swiper_id, lr.revealed_on, lr.notified_at
      from like_reveals lr where lr.user_id = v.id
      order by lr.revealed_on desc limit 1
    ) r on true
    where v.id = ${userId}`
  return row ?? null
}

async function latestReveal(userId: string): Promise<StoredReveal | null> {
  const [row] = await sql<StoredReveal[]>`
    select swiper_id, revealed_on, notified_at from like_reveals
    where user_id = ${userId}
    order by revealed_on desc
    limit 1`
  return row ?? null
}

/** Every like-swipe aimed at her, uncapped. */
async function loadLikeSwipes(userId: string): Promise<Array<{ swiper_id: string; created_at: string }>> {
  return sql<Array<{ swiper_id: string; created_at: string }>>`
    select swiper_id, created_at from swipes
    where swiped_id = ${userId} and direction = 'like'
    order by swiper_id asc`
}

type CandidateRow = {
  id: string
  liked_at: string
  name: string | null
  geo_city: string | null
  last_active: string | null
  is_seed: boolean | null
  paused_at: string | null
  deleted_at: string | null
  banned_at: string | null
  photo_count: number
}

/** Incoming likers she has not swiped, not blocked either way and not matched,
 *  filtered to reveal-eligible ones. Also returns their names (for the DM). */
async function loadCandidates(userId: string): Promise<{ candidates: RevealCandidate[]; names: Map<string, string> }> {
  // One statement (was: paged likes, paged her swipes, blocks, matches, then
  // users + photos in chunks of 50).
  const rows = await sql<CandidateRow[]>`
    select s.swiper_id as id, s.created_at as liked_at,
           u.name, u.geo_city, u.last_active, u.is_seed, u.paused_at, u.deleted_at, u.banned_at,
           (select count(*) from user_photos p where p.user_id = u.id)::int as photo_count
    from swipes s
    join users u on u.id = s.swiper_id
    where s.swiped_id = ${userId}
      and s.direction = 'like'
      and not exists (
        select 1 from swipes mine where mine.swiper_id = ${userId} and mine.swiped_id = s.swiper_id)
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${userId} and b.blocked_id = s.swiper_id)
           or (b.blocker_id = s.swiper_id and b.blocked_id = ${userId}))
      and not exists (
        select 1 from matches m
        where (m.user1_id = ${userId} and m.user2_id = s.swiper_id)
           or (m.user1_id = s.swiper_id and m.user2_id = ${userId}))
    order by s.swiper_id asc`

  const candidates: RevealCandidate[] = []
  const names = new Map<string, string>()
  for (const u of rows) {
    if (!isEligibleRevealLiker({
      isSeed: Boolean(u.is_seed),
      pausedAt: u.paused_at ?? null,
      deletedAt: u.deleted_at ?? null,
      bannedAt: u.banned_at ?? null,
      photoCount: u.photo_count,
    })) continue
    names.set(u.id, u.name ?? '')
    candidates.push({
      id: u.id,
      geoCity: u.geo_city ?? null,
      lastActive: u.last_active ?? u.liked_at ?? '',
      likedAt: u.liked_at ?? '',
    })
  }
  return { candidates, names }
}

/**
 * `waitForNotify: false` sends the like DM in the background so a user-facing
 * read isn't held up by Telegram. The reveal job keeps the default (await) so
 * its per-woman loop stays sequential and under the bot's send rate limit.
 */
export async function ensureDailyReveal(
  userId: string,
  now = new Date(),
  { waitForNotify = true }: { waitForNotify?: boolean } = {},
): Promise<RevealResult> {
  const viewer = await loadViewerState(userId)
  if (!viewer || viewer.gender !== 'woman' || viewer.is_seed) return { applies: false }

  const today = tehranDate(now)
  if (viewer.reveal_swiper_id) {
    const current = { swiper_id: viewer.reveal_swiper_id, revealed_on: viewer.reveal_revealed_on }
    if (!viewer.acted) {
      // An unanswered reveal outlives midnight only while he is still a live
      // incoming liker; a dead one must not lock her slot forever.
      if (viewer.live) return { applies: true, swiperId: current.swiper_id }
      if (current.revealed_on === today) return { applies: true, swiperId: null }
    } else if (current.revealed_on === today) {
      return { applies: true, swiperId: null }
    }
  }

  const { candidates, names } = await loadCandidates(userId)
  const picked = pickRevealCandidate({ geoCity: viewer.geo_city }, candidates)
  if (!picked) return { applies: true, swiperId: null }

  // One reveal per woman per Tehran day (PK user_id, revealed_on): a racing
  // insert loses quietly and reads the winner's pick.
  const inserted = await sql`
    insert into like_reveals (user_id, swiper_id, revealed_on)
    values (${userId}, ${picked.id}, ${today})
    on conflict (user_id, revealed_on) do nothing
    returning swiper_id`
  if (inserted.length === 0) {
    const raced = await latestReveal(userId)
    return { applies: true, swiperId: raced?.swiper_id ?? null }
  }

  // Push first, else a bot DM when Telegram allows it. notified_at is stamped
  // only when one of them actually went out.
  const notify = (async () => {
    try {
      const sent = await notifyUserLike(viewer, names.get(picked.id) ?? '', 'like_reveal')
      if (sent === 'none') return
      await sql`
        update like_reveals set notified_at = ${new Date().toISOString()}
        where user_id = ${userId} and revealed_on = ${today}`
    } catch (err) {
      console.error(err)
    }
  })()
  if (waitForNotify) await notify
  return { applies: true, swiperId: picked.id }
}

export async function hiddenIncomingLikerIds(userId: string, now = new Date()): Promise<string[]> {
  const reveal = await ensureDailyReveal(userId, now, { waitForNotify: false })
  if (!reveal.applies) return []
  const likes = await loadLikeSwipes(userId)
  return likes.map((l) => l.swiper_id).filter((id) => id !== reveal.swiperId)
}
