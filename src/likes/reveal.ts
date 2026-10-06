import { db } from '../db.js'
import { notifyNewLike } from '../bot.js'
import { getIncomingLikers } from './service.js'
import { isEligibleRevealLiker, pickRevealCandidate, tehranDate, type RevealCandidate } from './revealPick.js'

export type RevealResult = { applies: false } | { applies: true; swiperId: string | null }

type Viewer = {
  id: string
  gender: string
  geo_city: string | null
  telegram_id: number
  allows_write_to_pm: boolean | null
  locale: string | null
}

type StoredReveal = { swiper_id: string; revealed_on: string; notified_at: string | null }

async function loadViewer(userId: string): Promise<Viewer | null> {
  const { data } = await db
    .from('users')
    .select('id, gender, geo_city, telegram_id, allows_write_to_pm, locale')
    .eq('id', userId)
    .maybeSingle()
  return (data as Viewer | null) ?? null
}

async function latestReveal(userId: string): Promise<StoredReveal | null> {
  const { data } = await db
    .from('like_reveals')
    .select('swiper_id, revealed_on, notified_at')
    .eq('user_id', userId)
    .order('revealed_on', { ascending: false })
    .limit(1)
  return ((data as StoredReveal[] | null) ?? [])[0] ?? null
}

async function hasSwiped(userId: string, swiperId: string): Promise<boolean> {
  const { data } = await db
    .from('swipes')
    .select('swiped_id')
    .eq('swiper_id', userId)
    .eq('swiped_id', swiperId)
    .limit(1)
  return ((data as Array<{ swiped_id: string }> | null) ?? []).length > 0
}

async function loadCandidates(userId: string): Promise<RevealCandidate[]> {
  const incoming = await getIncomingLikers(userId)
  if (incoming.length === 0) return []
  const ids = incoming.map((l) => l.id)
  const [{ data: users }, { data: photos }] = await Promise.all([
    db.from('users').select('id, geo_city, last_active, is_seed, paused_at, deleted_at, banned_at, name').in('id', ids),
    db.from('user_photos').select('user_id').in('user_id', ids),
  ])
  const photoCount = new Map<string, number>()
  for (const p of (photos as Array<{ user_id: string }> | null) ?? []) {
    photoCount.set(p.user_id, (photoCount.get(p.user_id) ?? 0) + 1)
  }
  const byId = new Map(((users as any[] | null) ?? []).map((u) => [u.id, u]))
  const likedAt = new Map(incoming.map((l) => [l.id, l.likedAt]))
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

export async function ensureDailyReveal(userId: string, now = new Date()): Promise<RevealResult> {
  const viewer = await loadViewer(userId)
  if (!viewer || viewer.gender !== 'woman') return { applies: false }

  const today = tehranDate(now)
  const current = await latestReveal(userId)
  if (current) {
    const acted = await hasSwiped(userId, current.swiper_id)
    if (!acted) return { applies: true, swiperId: current.swiper_id }
    if (current.revealed_on === today) return { applies: true, swiperId: null }
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
    await notifyNewLike(viewer.telegram_id, name?.name ?? '', (viewer.locale as 'fa' | 'en' | 'ar' | null) ?? null)
    await db.from('like_reveals').update({ notified_at: new Date().toISOString() }).eq('user_id', userId).eq('revealed_on', today)
  }
  return { applies: true, swiperId: picked.id }
}

export async function hiddenIncomingLikerIds(userId: string, now = new Date()): Promise<string[]> {
  const reveal = await ensureDailyReveal(userId, now)
  if (!reveal.applies) return []
  const incoming = await getIncomingLikers(userId)
  return incoming.map((l) => l.id).filter((id) => id !== reveal.swiperId)
}
