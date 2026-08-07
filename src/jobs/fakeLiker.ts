import { db } from '../db.js'
import { notifyMatch, notifyNewMessage } from '../bot.js'
import { getFakeLikerConfig } from './fakeLikerConfig.js'

export interface RunStats {
  likesSent: number
  matchesCreated: number
  salamsSent: number
  skipped: number
  errors: number
}

/** Minimal structural logger — both `console` and a pino instance satisfy it. */
interface JobLogger {
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000
const CANDIDATE_BATCH = 200
const SCAN_CAP = 2000
const SALAM_CAP = 200
const TARGET_LOOKING_FOR = ['women', 'both', 'everyone']

/** Module-level concurrency guard: only one run at a time across schedule + manual triggers. */
let running = false

interface Fake {
  id: string
  name: string
  looking_for: string
  location: string | null
  counter: number
}

/** A fake (always gender=woman) is eligible to like a target iff her `looking_for` allows the target's gender. */
function fakeAllowsGender(lookingFor: string, gender: string): boolean {
  if (lookingFor === 'men') return gender === 'man'
  if (lookingFor === 'women') return gender === 'woman'
  return true // both / everyone
}

function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Among compatible fakes: lowest counter wins; ties broken by same-city, then first-seen. */
function pickFake(compatible: Fake[], targetLocation: string | null | undefined): Fake {
  let best = compatible[0]
  for (const f of compatible.slice(1)) {
    if (f.counter < best.counter) {
      best = f
    } else if (f.counter === best.counter) {
      if (sameCity(f.location, targetLocation) && !sameCity(best.location, targetLocation)) best = f
    }
  }
  return best
}

/**
 * Runs the fake-liker background job once. Never throws out of the entry point:
 * per-item failures are caught, counted, and logged; the run always finishes and
 * records a `fake_liker_runs` row (except when disabled / already-running, which
 * return early without a run row).
 */
export async function runFakeLikerJob(
  trigger: 'schedule' | 'manual',
  logger: JobLogger = console,
): Promise<RunStats | { skipped: string }> {
  const cfg = await getFakeLikerConfig()
  if (!cfg || !cfg.enabled) return { skipped: 'disabled' }

  if (running) return { skipped: 'already_running' }
  running = true

  const startedAt = new Date()
  const stats: RunStats = { likesSent: 0, matchesCreated: 0, salamsSent: 0, skipped: 0, errors: 0 }
  logger.info({ trigger }, 'fake liker run started')

  try {
    // --- Fake pool: active, non-banned women seeds ---
    const { data: pool, error: poolErr } = await db
      .from('users')
      .select('id, name, looking_for, location')
      .eq('is_seed', true)
      .eq('gender', 'woman')
      .eq('is_active', true)
      .is('banned_at', null)
      .is('deleted_at', null)

    if (poolErr) {
      stats.errors++
      logger.warn({ err: poolErr }, 'fake liker: pool fetch failed')
      return stats
    }

    const fakeIds = (pool ?? []).map((f: { id: string }) => f.id)
    if (fakeIds.length === 0) return stats // no fakes → record a zeroed run and finish

    // --- Seed per-fake like counters from history (for load balancing) ---
    const { data: counterRows } = await db
      .from('swipes')
      .select('swiper_id')
      .in('swiper_id', fakeIds)
      .eq('direction', 'like')
    const counters: Record<string, number> = {}
    for (const r of (counterRows ?? []) as Array<{ swiper_id: string }>) {
      counters[r.swiper_id] = (counters[r.swiper_id] ?? 0) + 1
    }

    // --- Fake primary photos (lowest position) for notifications ---
    const { data: photoRows } = await db
      .from('user_photos')
      .select('user_id, url')
      .in('user_id', fakeIds)
      .order('position', { ascending: true })
    const photoByFake: Record<string, string> = {}
    for (const p of (photoRows ?? []) as Array<{ user_id: string; url: string }>) {
      if (!(p.user_id in photoByFake)) photoByFake[p.user_id] = p.url
    }
    const fakePhoto = (id: string): string | null => photoByFake[id] ?? null

    const fakes: Fake[] = (pool ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      looking_for: f.looking_for,
      location: f.location ?? null,
      counter: counters[f.id] ?? 0,
    }))

    // --- Target selection: page through eligible candidates, exclude any with a received like ---
    const cutoff = new Date(Date.now() - FOUR_HOURS_MS).toISOString()
    const targets: Array<{ id: string; gender: string; telegram_id: number; allows_write_to_pm: boolean | null; location: string | null }> = []
    let scanned = 0
    let offset = 0

    while (targets.length < cfg.maxTargetsPerRun && scanned < SCAN_CAP) {
      const { data: batch, error: batchErr } = await db
        .from('users')
        .select('id, gender, telegram_id, allows_write_to_pm, location')
        .eq('is_seed', false)
        .eq('is_active', true)
        .is('banned_at', null)
        .is('deleted_at', null)
        .lte('created_at', cutoff)
        .in('looking_for', TARGET_LOOKING_FOR)
        .order('created_at', { ascending: false })
        .range(offset, offset + CANDIDATE_BATCH - 1)

      if (batchErr) {
        stats.errors++
        logger.warn({ err: batchErr }, 'fake liker: candidate fetch failed')
        break
      }
      const rows = (batch ?? []) as typeof targets
      if (rows.length === 0) break
      scanned += rows.length

      const ids = rows.map((r) => r.id)
      const { data: liked } = await db
        .from('swipes')
        .select('swiped_id')
        .in('swiped_id', ids)
        .eq('direction', 'like')
      const likedSet = new Set((liked ?? []).map((l: { swiped_id: string }) => l.swiped_id))

      for (const cand of rows) {
        if (likedSet.has(cand.id)) continue
        targets.push(cand)
        if (targets.length >= cfg.maxTargetsPerRun) break
      }

      if (rows.length < CANDIDATE_BATCH) break
      offset += CANDIDATE_BATCH
    }

    // --- Like phase: one fake likes each target; create match on reverse-like ---
    for (const target of targets) {
      try {
        const compatible = fakes.filter((f) => fakeAllowsGender(f.looking_for, target.gender))
        if (compatible.length === 0) continue

        const fake = pickFake(compatible, target.location)
        fake.counter++ // count the assignment immediately so load stays balanced

        const { error: swipeErr } = await db
          .from('swipes')
          .insert({ swiper_id: fake.id, swiped_id: target.id, direction: 'like' })

        if ((swipeErr as any)?.code === '23505') {
          stats.skipped++
          continue
        }
        if (swipeErr) {
          stats.errors++
          logger.warn({ err: swipeErr, fake: fake.id, target: target.id }, 'fake liker: swipe insert failed')
          continue
        }
        stats.likesSent++

        // Reverse-like? (target already liked this fake) → it's a match.
        const { data: reverse } = await db
          .from('swipes')
          .select('id')
          .eq('swiper_id', target.id)
          .eq('swiped_id', fake.id)
          .eq('direction', 'like')
          .maybeSingle()
        if (!reverse) continue

        const [u1, u2] = [fake.id, target.id].sort()
        const { data: match, error: matchErr } = await db
          .from('matches')
          .insert({ user1_id: u1, user2_id: u2 })
          .select('id')
          .single()

        if ((matchErr as any)?.code === '23505') continue // already matched — no side effects
        if (matchErr || !match) {
          stats.errors++
          logger.warn({ err: matchErr, fake: fake.id, target: target.id }, 'fake liker: match insert failed')
          continue
        }
        stats.matchesCreated++

        // Notify the real user only (fakes have a negative sentinel telegram_id).
        if (target.telegram_id > 0 && target.allows_write_to_pm !== false) {
          notifyMatch([{ telegramId: target.telegram_id, matchName: fake.name, matchPhoto: fakePhoto(fake.id) }])
            .catch((err) => logger.warn({ err }, 'fake liker: match notify failed'))
        }
      } catch (err) {
        stats.errors++
        logger.warn({ err }, 'fake liker: target processing failed')
      }
    }

    // --- Salam phase: open every fake-involved match with "salam" if it has no messages yet ---
    // Runs every time (independent of the like phase) so it also seeds matches the real
    // swipe route created. Two `.in` queries + dedupe stand in for an OR anti-join.
    const fakeIdSet = new Set(fakeIds)
    const matchMap = new Map<string, { id: string; user1_id: string; user2_id: string }>()
    for (const col of ['user1_id', 'user2_id'] as const) {
      const { data: rows } = await db
        .from('matches')
        .select('id, user1_id, user2_id')
        .in(col, fakeIds)
        .limit(SALAM_CAP)
      for (const m of (rows ?? []) as Array<{ id: string; user1_id: string; user2_id: string }>) {
        matchMap.set(m.id, m)
      }
    }
    const candidateMatches = [...matchMap.values()].slice(0, SALAM_CAP)

    if (candidateMatches.length > 0) {
      // Real users on the non-fake side (skip both-fake matches).
      const realIds = new Set<string>()
      for (const m of candidateMatches) {
        const u1Fake = fakeIdSet.has(m.user1_id)
        const u2Fake = fakeIdSet.has(m.user2_id)
        if (u1Fake && u2Fake) continue
        realIds.add(u1Fake ? m.user2_id : m.user1_id)
      }

      const { data: realUsers } = await db
        .from('users')
        .select('id, telegram_id, deleted_at, banned_at, last_active, notified_offline_at, allows_write_to_pm')
        .in('id', [...realIds])
      const realMap = new Map((realUsers ?? []).map((u: any) => [u.id, u]))

      const matchIds = candidateMatches.map((m) => m.id)
      const { data: msgs } = await db.from('messages').select('match_id').in('match_id', matchIds)
      const withMessages = new Set((msgs ?? []).map((x: { match_id: string }) => x.match_id))

      for (const m of candidateMatches) {
        try {
          const u1Fake = fakeIdSet.has(m.user1_id)
          const u2Fake = fakeIdSet.has(m.user2_id)
          if (u1Fake && u2Fake) continue // both-fake → skip

          const fakeId = u1Fake ? m.user1_id : m.user2_id
          const realId = u1Fake ? m.user2_id : m.user1_id
          const real: any = realMap.get(realId)
          if (!real || real.deleted_at || real.banned_at) continue // real side gone → skip
          if (withMessages.has(m.id)) continue // already has messages → skip

          const fake = fakes.find((f) => f.id === fakeId)
          if (!fake) continue

          const { error: msgErr } = await db
            .from('messages')
            .insert({ match_id: m.id, sender_id: fakeId, body: 'salam' })
          if (msgErr) {
            stats.errors++
            logger.warn({ err: msgErr, match: m.id }, 'fake liker: salam insert failed')
            continue
          }
          stats.salamsSent++

          // Offline-notify the real user (mirror messages route rules).
          const isOffline = !real.last_active || Date.now() - new Date(real.last_active).getTime() > OFFLINE_THRESHOLD_MS
          if (isOffline && !real.notified_offline_at && real.allows_write_to_pm !== false && real.telegram_id > 0) {
            notifyNewMessage(real.telegram_id, fake.name, 'salam', fakePhoto(fakeId))
              .then(() =>
                db.from('users').update({ notified_offline_at: new Date().toISOString() }).eq('id', realId),
              )
              .catch((err) => logger.warn({ err }, 'fake liker: salam notify failed'))
          }
        } catch (err) {
          stats.errors++
          logger.warn({ err }, 'fake liker: salam processing failed')
        }
      }
    }

    return stats
  } catch (err) {
    stats.errors++
    logger.warn({ err }, 'fake liker: unexpected run error')
    return stats
  } finally {
    try {
      await db.from('fake_liker_runs').insert({
        trigger,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        likes_sent: stats.likesSent,
        matches_created: stats.matchesCreated,
        salams_sent: stats.salamsSent,
        errors: stats.errors,
      })
    } catch (err) {
      logger.warn({ err }, 'fake liker: run row insert failed')
    }
    running = false
    logger.info({ ...stats }, 'fake liker run finished')
  }
}
