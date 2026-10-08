import { db } from '../db.js'
import { notifyNewLike } from '../bot.js'
import { isEligibleRevealLiker, pickRevealCandidate, tehranDate, type RevealCandidate } from './revealPick.js'

export type RevealResult = { applies: false } | { applies: true; swiperId: string | null }

type Viewer = {
  id: string
  gender: string
  is_seed: boolean | null
  geo_city: string | null
  telegram_id: number
  allows_write_to_pm: boolean | null
  locale: string | null
}

type StoredReveal = { swiper_id: string; revealed_on: string; notified_at: string | null }

const PAGE = 1000
// Ids per `.in('id', …)` read — keeps the request URL short.
const CHUNK = 50

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// A query error must fail the whole reveal: reading it as "no row" would either
// show her every like (viewer) or send a second like DM (reveal).
async function loadViewer(userId: string): Promise<Viewer | null> {
  const { data, error } = await db
    .from('users')
    .select('id, gender, is_seed, geo_city, telegram_id, allows_write_to_pm, locale')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return (data as Viewer | null) ?? null
}

async function latestReveal(userId: string): Promise<StoredReveal | null> {
  const { data, error } = await db
    .from('like_reveals')
    .select('swiper_id, revealed_on, notified_at')
    .eq('user_id', userId)
    .order('revealed_on', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data as StoredReveal[] | null) ?? [])[0] ?? null
}

async function hasSwiped(userId: string, swiperId: string): Promise<boolean> {
  const { data, error } = await db
    .from('swipes')
    .select('swiped_id')
    .eq('swiper_id', userId)
    .eq('swiped_id', swiperId)
    .limit(1)
  if (error) throw error
  return ((data as Array<{ swiped_id: string }> | null) ?? []).length > 0
}

/** Every like-swipe aimed at her, uncapped (paged). */
async function loadLikeSwipes(userId: string): Promise<Array<{ swiper_id: string; created_at: string }>> {
  const rows: Array<{ swiper_id: string; created_at: string }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('swipes')
      .select('swiper_id, created_at')
      .eq('swiped_id', userId)
      .eq('direction', 'like')
      .order('swiper_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data as Array<{ swiper_id: string; created_at: string }> | null) ?? []
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return rows
}

/** Everyone she has already swiped (either direction), uncapped (paged). */
async function loadSwipedByHer(userId: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('swipes')
      .select('swiped_id')
      .eq('swiper_id', userId)
      .order('swiped_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data as Array<{ swiped_id: string }> | null) ?? []
    for (const r of page) ids.add(r.swiped_id)
    if (page.length < PAGE) break
  }
  return ids
}

async function loadBlockedEitherWay(userId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
  if (error) throw error
  return new Set(
    ((data as Array<{ blocker_id: string; blocked_id: string }> | null) ?? []).map((b) =>
      b.blocker_id === userId ? b.blocked_id : b.blocker_id,
    ),
  )
}

async function loadMatchedIds(userId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from('matches')
    .select('user1_id, user2_id')
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
  if (error) throw error
  return new Set(
    ((data as Array<{ user1_id: string; user2_id: string }> | null) ?? []).map((m) =>
      m.user1_id === userId ? m.user2_id : m.user1_id,
    ),
  )
}

/**
 * Is `likerId` still a live incoming liker of `userId`? Seed / no-photo do NOT
 * count as gone (an already-shown reveal can stay). Gone = deleted, banned,
 * paused, blocked either way, or matched (any route). Throws on any read error.
 */
async function isStillLiveLiker(userId: string, likerId: string): Promise<boolean> {
  const pair = (a: string, b: string, x: string, y: string) =>
    `and(${x}.eq.${a},${y}.eq.${b}),and(${x}.eq.${b},${y}.eq.${a})`
  const [userRes, blockRes, matchRes] = await Promise.all([
    db.from('users').select('id, deleted_at, banned_at, paused_at').eq('id', likerId).maybeSingle(),
    db.from('blocks').select('blocker_id').or(pair(userId, likerId, 'blocker_id', 'blocked_id')).limit(1),
    db.from('matches').select('user1_id').or(pair(userId, likerId, 'user1_id', 'user2_id')).limit(1),
  ])
  if (userRes.error) throw userRes.error
  if (blockRes.error) throw blockRes.error
  if (matchRes.error) throw matchRes.error
  const u = userRes.data as { deleted_at: string | null; banned_at: string | null; paused_at: string | null } | null
  if (!u || u.deleted_at || u.banned_at || u.paused_at) return false
  if (((blockRes.data as unknown[] | null) ?? []).length > 0) return false
  if (((matchRes.data as unknown[] | null) ?? []).length > 0) return false
  return true
}

async function loadCandidates(userId: string): Promise<RevealCandidate[]> {
  const likes = await loadLikeSwipes(userId)
  if (likes.length === 0) return []
  const [swiped, blocked, matched] = await Promise.all([
    loadSwipedByHer(userId),
    loadBlockedEitherWay(userId),
    loadMatchedIds(userId),
  ])
  const likedAt = new Map<string, string>()
  for (const l of likes) {
    if (swiped.has(l.swiper_id) || blocked.has(l.swiper_id) || matched.has(l.swiper_id)) continue
    likedAt.set(l.swiper_id, l.created_at)
  }
  const ids = [...likedAt.keys()]
  if (ids.length === 0) return []

  const byId = new Map<string, any>()
  const photoCount = new Map<string, number>()
  for (const part of chunks(ids, CHUNK)) {
    const [usersRes, photosRes] = await Promise.all([
      db.from('users').select('id, geo_city, last_active, is_seed, paused_at, deleted_at, banned_at, name').in('id', part),
      db.from('user_photos').select('user_id').in('user_id', part),
    ])
    if (usersRes.error) throw usersRes.error
    if (photosRes.error) throw photosRes.error
    for (const u of (usersRes.data as any[] | null) ?? []) byId.set(u.id, u)
    for (const p of (photosRes.data as Array<{ user_id: string }> | null) ?? []) {
      photoCount.set(p.user_id, (photoCount.get(p.user_id) ?? 0) + 1)
    }
  }
  const candidates: RevealCandidate[] = []
  for (const id of ids) {
    const u = byId.get(id)
    if (!u) continue
    if (!isEligibleRevealLiker({
      isSeed: Boolean(u.is_seed),
      pausedAt: u.paused_at ?? null,
      deletedAt: u.deleted_at ?? null,
      bannedAt: u.banned_at ?? null,
      photoCount: photoCount.get(id) ?? 0,
    })) continue
    candidates.push({
      id,
      geoCity: u.geo_city ?? null,
      lastActive: u.last_active ?? likedAt.get(id) ?? '',
      likedAt: likedAt.get(id) ?? '',
    })
  }
  return candidates
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
  const viewer = await loadViewer(userId)
  if (!viewer || viewer.gender !== 'woman' || viewer.is_seed) return { applies: false }

  const today = tehranDate(now)
  const current = await latestReveal(userId)
  if (current) {
    const acted = await hasSwiped(userId, current.swiper_id)
    if (!acted) {
      // An unanswered reveal outlives midnight only while he is still a live
      // incoming liker; a dead one must not lock her slot forever.
      if (await isStillLiveLiker(userId, current.swiper_id)) return { applies: true, swiperId: current.swiper_id }
      if (current.revealed_on === today) return { applies: true, swiperId: null }
    } else if (current.revealed_on === today) {
      return { applies: true, swiperId: null }
    }
  }

  const candidates = await loadCandidates(userId)
  const picked = pickRevealCandidate({ geoCity: viewer.geo_city }, candidates)
  if (!picked) return { applies: true, swiperId: null }

  const { data: inserted, error } = await db
    .from('like_reveals')
    .insert({ user_id: userId, swiper_id: picked.id, revealed_on: today })
    .select('swiper_id')
  if (error && (error as { code?: string }).code !== '23505') throw error
  if (!inserted || (inserted as unknown[]).length === 0) {
    const raced = await latestReveal(userId)
    return { applies: true, swiperId: raced?.swiper_id ?? null }
  }

  const name = (await db.from('users').select('name').eq('id', picked.id).maybeSingle()).data as { name?: string } | null
  if (viewer.telegram_id > 0 && viewer.allows_write_to_pm !== false) {
    const notify = (async () => {
      try {
        await notifyNewLike(viewer.telegram_id, name?.name ?? '', (viewer.locale as 'fa' | 'en' | 'ar' | null) ?? null)
        await db.from('like_reveals').update({ notified_at: new Date().toISOString() }).eq('user_id', userId).eq('revealed_on', today)
      } catch (err) {
        console.error(err)
      }
    })()
    if (waitForNotify) await notify
  }
  return { applies: true, swiperId: picked.id }
}

export async function hiddenIncomingLikerIds(userId: string, now = new Date()): Promise<string[]> {
  const reveal = await ensureDailyReveal(userId, now, { waitForNotify: false })
  if (!reveal.applies) return []
  const likes = await loadLikeSwipes(userId)
  return likes.map((l) => l.swiper_id).filter((id) => id !== reveal.swiperId)
}
