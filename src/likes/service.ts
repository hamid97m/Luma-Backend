import { db } from '../db.js'
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

export async function getIncomingLikers(userId: string): Promise<IncomingLiker[]> {
  // (1) People who liked me, with their profile joined (mirrors the matches join pattern).
  const { data: incoming } = await db
    .from('swipes')
    .select('swiper_id, created_at, swiper:users!swipes_swiper_id_fkey(id, name, age, bio, location, interests, telegram_id, gender, deleted_at, banned_at, paused_at, premium_until)')
    .eq('swiped_id', userId)
    .eq('direction', 'like')
    .order('created_at', { ascending: false })

  const rows = (incoming ?? []) as any[]
  if (rows.length === 0) return []

  // (2) Everyone I've already swiped (either direction) — exclude; I acted on them.
  const { data: mySwipes } = await db
    .from('swipes')
    .select('swiped_id')
    .eq('swiper_id', userId)
  const swipedIds = new Set((mySwipes ?? []).map((s: { swiped_id: string }) => s.swiped_id))

  // (3) Blocks, either direction.
  const { data: blockRows } = await db
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
  const blockedIds = new Set(
    (blockRows ?? []).map((b: { blocker_id: string; blocked_id: string }) =>
      b.blocker_id === userId ? b.blocked_id : b.blocker_id,
    ),
  )

  // (4) Matched partners — they belong in Matches, not Likes.
  const { data: matchRows } = await db
    .from('matches')
    .select('user1_id, user2_id')
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
  const matchedIds = new Set(
    (matchRows ?? []).map((m: { user1_id: string; user2_id: string }) =>
      m.user1_id === userId ? m.user2_id : m.user1_id,
    ),
  )

  const out: IncomingLiker[] = []
  for (const row of rows) {
    const s = row.swiper
    if (!s || s.deleted_at || s.banned_at || s.paused_at) continue
    if (swipedIds.has(s.id) || blockedIds.has(s.id) || matchedIds.has(s.id)) continue
    out.push({
      id: s.id,
      name: s.name,
      age: s.age ?? null,
      bio: s.bio ?? null,
      location: s.location ?? null,
      interests: s.interests ?? [],
      telegramId: s.telegram_id,
      gender: s.gender ?? null,
      likedAt: row.created_at,
      premium: isPremiumActive(s.premium_until ?? null),
    })
    if (out.length >= MAX_LIKERS) break
  }
  // Sort by likedAt descending (newest first) — handles both sorted and unsorted incoming data
  out.sort((a, b) => new Date(b.likedAt).getTime() - new Date(a.likedAt).getTime())
  return out
}

/**
 * One specific liker, with the same exclusions as getIncomingLikers but for this
 * pair only and without the newest-100 cap. Used for the daily reveal, whose pick
 * can be older than the capped list. Null when he no longer qualifies.
 */
export async function getIncomingLiker(userId: string, swiperId: string): Promise<IncomingLiker | null> {
  const { data: likeRows, error: likeErr } = await db
    .from('swipes')
    .select('swiper_id, created_at, swiper:users!swipes_swiper_id_fkey(id, name, age, bio, location, interests, telegram_id, gender, deleted_at, banned_at, paused_at, premium_until)')
    .eq('swiped_id', userId)
    .eq('swiper_id', swiperId)
    .eq('direction', 'like')
    .limit(1)
  if (likeErr) throw likeErr
  const row = ((likeRows ?? []) as any[])[0]
  const s = row?.swiper
  if (!s || s.deleted_at || s.banned_at || s.paused_at) return null

  const [mine, blocks, matches] = await Promise.all([
    db.from('swipes').select('swiped_id').eq('swiper_id', userId).eq('swiped_id', swiperId).limit(1),
    db.from('blocks').select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${userId},blocked_id.eq.${swiperId}),and(blocker_id.eq.${swiperId},blocked_id.eq.${userId})`)
      .limit(1),
    db.from('matches').select('user1_id, user2_id')
      .or(`and(user1_id.eq.${userId},user2_id.eq.${swiperId}),and(user1_id.eq.${swiperId},user2_id.eq.${userId})`)
      .limit(1),
  ])
  for (const r of [mine, blocks, matches]) if (r.error) throw r.error
  if ((mine.data ?? []).length > 0 || (blocks.data ?? []).length > 0 || (matches.data ?? []).length > 0) return null

  return {
    id: s.id,
    name: s.name,
    age: s.age ?? null,
    bio: s.bio ?? null,
    location: s.location ?? null,
    interests: s.interests ?? [],
    telegramId: s.telegram_id,
    gender: s.gender ?? null,
    likedAt: row.created_at,
    premium: isPremiumActive(s.premium_until ?? null),
  }
}
