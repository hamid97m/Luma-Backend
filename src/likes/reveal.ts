import { db } from '../db.js'
import { notifyNewLike } from '../bot.js'
import type { Locale } from '../i18n/index.js'
import { getIncomingLikers } from './service.js'
import { isEligibleRevealLiker, pickRevealCandidate, tehranDate, type RevealCandidate } from './revealPick.js'

export interface VisibleReveal {
  swiperId: string
  likedAt: string
  /** True only on the call that inserted today's row. */
  created: boolean
}

interface WomanRow {
  id: string
  gender: string | null
  geo_city: string | null
  telegram_id: number
  allows_write_to_pm: boolean | null
  locale: string | null
}

interface RevealRow {
  user_id: string
  swiper_id: string
  revealed_on: string
  notified_at: string | null
}

interface LoadedCandidate extends RevealCandidate {
  name: string
}

const REVEAL_CANDIDATE_CAP = 1000
const SWIPE_PAGE = 1000
const MAX_SWIPE_PAGES = 20

async function loadWoman(userId: string): Promise<WomanRow | null> {
  const { data, error } = await db
    .from('users')
    .select('id, gender, geo_city, telegram_id, allows_write_to_pm, locale')
    .eq('id', userId)
    .single()
  if (error) throw error
  return (data as WomanRow | null) ?? null
}

async function latestReveal(userId: string): Promise<RevealRow | null> {
  const { data, error } = await db
    .from('like_reveals')
    .select('user_id, swiper_id, revealed_on, notified_at')
    .eq('user_id', userId)
    .order('revealed_on', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as RevealRow | null) ?? null
}

async function sheActedOn(userId: string, swiperId: string): Promise<boolean> {
  const { data, error } = await db
    .from('swipes')
    .select('id')
    .eq('swiper_id', userId)
    .eq('swiped_id', swiperId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

async function loadCandidates(userId: string): Promise<LoadedCandidate[]> {
  const incoming = await getIncomingLikers(userId, REVEAL_CANDIDATE_CAP)
  if (incoming.length === 0) return []

  const ids = incoming.map((l) => l.id)
  const [{ data: users, error: usersErr }, { data: photos, error: photosErr }] = await Promise.all([
    db.from('users').select('id, geo_city, last_active, is_seed, paused_at, deleted_at, banned_at').in('id', ids),
    db.from('user_photos').select('user_id').in('user_id', ids),
  ])
  if (usersErr) throw usersErr
  if (photosErr) throw photosErr

  const byId = new Map((users ?? []).map((u: { id: string }) => [u.id, u as {
    id: string
    geo_city: string | null
    last_active: string | null
    is_seed: boolean
    paused_at: string | null
    deleted_at: string | null
    banned_at: string | null
  }]))
  const photoCount = new Map<string, number>()
  for (const p of (photos ?? []) as Array<{ user_id: string }>) {
    photoCount.set(p.user_id, (photoCount.get(p.user_id) ?? 0) + 1)
  }

  const loaded: LoadedCandidate[] = []
  for (const liker of incoming) {
    const u = byId.get(liker.id)
    const eligible = isEligibleRevealLiker({
      isSeed: u?.is_seed === true,
      pausedAt: u?.paused_at ?? null,
      deletedAt: u?.deleted_at ?? null,
      bannedAt: u?.banned_at ?? null,
      photoCount: photoCount.get(liker.id) ?? 0,
    })
    if (!eligible) continue
    loaded.push({
      id: liker.id,
      name: liker.name,
      geoCity: u?.geo_city ?? null,
      lastActive: u?.last_active ?? '',
      likedAt: liker.likedAt,
    })
  }
  return loaded
}

function visibleOf(candidate: { id: string; likedAt: string }, created: boolean): VisibleReveal {
  return { swiperId: candidate.id, likedAt: candidate.likedAt, created }
}

async function notifyReveal(woman: WomanRow, likerName: string, today: string): Promise<void> {
  if (!(woman.telegram_id > 0) || woman.allows_write_to_pm === false) return
  try {
    await notifyNewLike(woman.telegram_id, likerName, (woman.locale as Locale | null) ?? null)
    const { error } = await db
      .from('like_reveals')
      .update({ notified_at: new Date().toISOString() })
      .eq('user_id', woman.id)
      .eq('revealed_on', today)
    if (error) console.error('[reveal] notified_at update failed', error)
  } catch (err) {
    console.error('[reveal] new-like notify failed', err)
  }
}

async function insertReveal(woman: WomanRow, chosen: LoadedCandidate, today: string): Promise<VisibleReveal | null> {
  const { error } = await db
    .from('like_reveals')
    .insert({
      user_id: woman.id,
      swiper_id: chosen.id,
      revealed_on: today,
      notified_at: null,
    })
    .select('user_id')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const { data: existing, error: readErr } = await db
        .from('like_reveals')
        .select('swiper_id')
        .eq('user_id', woman.id)
        .eq('revealed_on', today)
        .maybeSingle()
      if (readErr) throw readErr
      if (!existing) return null
      return { swiperId: (existing as { swiper_id: string }).swiper_id, likedAt: chosen.likedAt, created: false }
    }
    throw error
  }
  await notifyReveal(woman, chosen.name, today)
  return visibleOf(chosen, true)
}

/**
 * The one like a woman is allowed to see. Inserts at most one row per Tehran
 * date and sends the like DM only when that insert happens. Callers must
 * already know the viewer is a woman; anyone else gets null.
 * An unanswered reveal stays across midnight and is not announced again.
 */
export async function ensureDailyReveal(userId: string, now: Date = new Date()): Promise<VisibleReveal | null> {
  const woman = await loadWoman(userId)
  if (!woman || woman.gender !== 'woman') return null

  const today = tehranDate(now)
  const latest = await latestReveal(userId)
  const acted = latest ? await sheActedOn(userId, latest.swiper_id) : false
  if (latest && acted && latest.revealed_on === today) return null

  const candidates = await loadCandidates(userId)

  if (latest && !acted) {
    const still = candidates.find((c) => c.id === latest.swiper_id)
    if (still) return visibleOf(still, false)
    if (latest.revealed_on === today) return null
  }

  const chosen = pickRevealCandidate({ geoCity: woman.geo_city }, candidates)
  if (!chosen) return null
  const loaded = candidates.find((c) => c.id === chosen.id)!
  return insertReveal(woman, loaded, today)
}

async function womenWithIncomingLikes(): Promise<string[]> {
  const swipedIds = new Set<string>()
  for (let page = 0; page < MAX_SWIPE_PAGES; page++) {
    const from = page * SWIPE_PAGE
    const { data, error } = await db
      .from('swipes')
      .select('swiped_id')
      .eq('direction', 'like')
      .range(from, from + SWIPE_PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as Array<{ swiped_id: string }>
    for (const row of rows) swipedIds.add(row.swiped_id)
    if (rows.length < SWIPE_PAGE) break
  }

  const all = [...swipedIds]
  const women: string[] = []
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200)
    const { data, error } = await db
      .from('users')
      .select('id')
      .in('id', chunk)
      .eq('gender', 'woman')
      .is('deleted_at', null)
      .is('banned_at', null)
    if (error) throw error
    for (const row of (data ?? []) as Array<{ id: string }>) women.push(row.id)
  }
  return women
}

/** 18:00 Asia/Tehran. Women who already have today's row are left alone. */
export async function runDailyRevealPass(
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  now: Date = new Date(),
): Promise<{ considered: number; revealed: number }> {
  const today = tehranDate(now)
  const womanIds = await womenWithIncomingLikes()
  const { data: already, error } = await db.from('like_reveals').select('user_id').eq('revealed_on', today)
  if (error) throw error
  const done = new Set((already ?? []).map((r: { user_id: string }) => r.user_id))

  let revealed = 0
  let considered = 0
  for (const id of womanIds) {
    if (done.has(id)) continue
    considered++
    try {
      const result = await ensureDailyReveal(id, now)
      if (result?.created) revealed++
    } catch (err) {
      log.warn({ err, userId: id }, 'daily reveal: user failed')
    }
  }
  log.info({ considered, revealed, skipped: womanIds.length - considered }, 'daily reveal pass')
  return { considered, revealed }
}
