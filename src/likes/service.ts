import { sql } from '../db.js'
import { isPremiumActive } from '../premium/service.js'

export interface IncomingLiker {
  id: string
  name: string
  age: number | null
  bio: string | null
  location: string | null
  interests: string[]
  telegramId: number
  gender: string | null
  likedAt: string
  /** Active premium only — expiry is not exposed to other users. */
  premium: boolean
}

const MAX_LIKERS = 100

type LikerRow = {
  id: string
  name: string
  age: number | null
  bio: string | null
  location: string | null
  interests: string[] | null
  telegram_id: number
  gender: string | null
  premium_until: string | null
  liked_at: string
}

function toLiker(r: LikerRow): IncomingLiker {
  return {
    id: r.id,
    name: r.name,
    age: r.age ?? null,
    bio: r.bio ?? null,
    location: r.location ?? null,
    interests: r.interests ?? [],
    telegramId: r.telegram_id,
    gender: r.gender ?? null,
    likedAt: r.liked_at,
    premium: isPremiumActive(r.premium_until ?? null),
  }
}

/**
 * Like-swipes aimed at `userId` whose swiper still qualifies as an incoming liker:
 * not deleted/banned/paused, not already swiped by me (either direction), not
 * blocked either way, not a matched partner (they belong in Matches, not Likes).
 * `swiperId` narrows to one pair.
 */
function likerQuery(userId: string, swiperId: string | null, limit: number) {
  return sql<LikerRow[]>`
    select u.id, u.name, u.age, u.bio, u.location, u.interests, u.telegram_id, u.gender,
           u.premium_until, s.created_at as liked_at
    from swipes s
    join users u on u.id = s.swiper_id
    where s.swiped_id = ${userId}
      and s.direction = 'like'
      ${swiperId !== null ? sql`and s.swiper_id = ${swiperId}` : sql``}
      and u.deleted_at is null and u.banned_at is null and u.paused_at is null
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
    order by s.created_at desc
    limit ${limit}`
}

export async function getIncomingLikers(userId: string): Promise<IncomingLiker[]> {
  // One statement (was four reads: incoming likes, my swipes, blocks, matches).
  // The old reads ignored their errors and an incoming-read failure gave [] —
  // keep "never throws, empty on failure".
  try {
    const rows = await likerQuery(userId, null, MAX_LIKERS)
    return rows.map(toLiker) // newest first
  } catch (err) {
    console.error('getIncomingLikers failed', err)
    return []
  }
}

/**
 * One specific liker, with the same exclusions as getIncomingLikers but for this
 * pair only and without the newest-100 cap. Used for the daily reveal, whose pick
 * can be older than the capped list. Null when he no longer qualifies.
 * Throws on a read error (as before).
 */
export async function getIncomingLiker(userId: string, swiperId: string): Promise<IncomingLiker | null> {
  const [row] = await likerQuery(userId, swiperId, 1)
  return row ? toLiker(row) : null
}
