import { db } from '../db.js'

export interface IncomingLiker {
  id: string
  name: string
  age: number | null
  bio: string | null
  telegramId: number
  gender: string | null
  likedAt: string
}

const MAX_LIKERS = 100

export async function getIncomingLikers(userId: string): Promise<IncomingLiker[]> {
  // (1) People who liked me, with their profile joined (mirrors the matches join pattern).
  const { data: incoming } = await db
    .from('swipes')
    .select('swiper_id, created_at, swiper:users!swipes_swiper_id_fkey(id, name, age, bio, telegram_id, gender, deleted_at, banned_at)')
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
    if (!s || s.deleted_at || s.banned_at) continue
    if (swipedIds.has(s.id) || blockedIds.has(s.id) || matchedIds.has(s.id)) continue
    out.push({
      id: s.id,
      name: s.name,
      age: s.age ?? null,
      bio: s.bio ?? null,
      telegramId: s.telegram_id,
      gender: s.gender ?? null,
      likedAt: row.created_at,
    })
    if (out.length >= MAX_LIKERS) break
  }
  // Sort by likedAt descending (newest first) — handles both sorted and unsorted incoming data
  out.sort((a, b) => new Date(b.likedAt).getTime() - new Date(a.likedAt).getTime())
  return out
}
