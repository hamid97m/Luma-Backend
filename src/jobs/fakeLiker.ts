import { db } from '../db.js'
import { notifyMatch, notifyNewLike } from '../bot.js'
import { getFakeLikerConfig } from './fakeLikerConfig.js'
import { deliverMessageNotification } from '../messaging/deliver.js'

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
const CANDIDATE_BATCH = 200
const RECEIVED_LIKE_PAGE_SIZE = 1000
const INCOMING_LIKE_PAGE_SIZE = 1000
const SCAN_CAP = 2000
const SALAM_CAP = 200
const TARGET_LOOKING_FOR = ['women', 'both', 'everyone']
/** A real user never accumulates more than this many fake matches — real people
 * don't all like you back, so beyond this the liked fakes simply don't reciprocate. */
const MAX_FAKE_MATCHES_PER_USER = 2

/** Module-level concurrency guard: only one run at a time across schedule + manual triggers. */
let running = false

/** Next scheduled run time, set by the scheduler in index.ts; null when the scheduler isn't armed (dev). */
let nextScheduledRunAt: string | null = null

export function setNextScheduledRunAt(ts: string | null): void {
  nextScheduledRunAt = ts
}

export function getNextScheduledRunAt(): string | null {
  return nextScheduledRunAt
}

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

interface LikeTarget {
  id: string
  gender: string
  telegram_id: number
  allows_write_to_pm: boolean | null
}

/**
 * A fake likes one target, then reconciles the outcome:
 *   - reverse like present → create the match (sorted pair) and notify the real user
 *   - no reverse like      → send the "someone liked you" DM
 * Mutates `stats`. The caller is responsible for incrementing `fake.counter`
 * before calling (so load balancing sees the assignment immediately).
 * Shared by the like-back phase (reverse like is guaranteed) and the cold-outreach
 * phase (reverse like is the exception) so both paths stay in lockstep.
 */
async function likeTargetAndMatch(
  fake: Fake,
  target: LikeTarget,
  fakePhoto: (id: string) => string | null,
  stats: RunStats,
  logger: JobLogger,
): Promise<void> {
  const { error: swipeErr } = await db
    .from('swipes')
    .insert({ swiper_id: fake.id, swiped_id: target.id, direction: 'like' })

  if ((swipeErr as any)?.code === '23505') {
    stats.skipped++
    return
  }
  if (swipeErr) {
    stats.errors++
    logger.warn({ err: swipeErr, fake: fake.id, target: target.id }, 'fake liker: swipe insert failed')
    return
  }
  stats.likesSent++

  // Reverse-like? (target already liked this fake) → it's a match.
  const { data: reverse, error: reverseErr } = await db
    .from('swipes')
    .select('id')
    .eq('swiper_id', target.id)
    .eq('swiped_id', fake.id)
    .eq('direction', 'like')
    .maybeSingle()
  if (reverseErr) {
    // A transient error read as "no reverse like" would permanently miss the match
    // (neither side re-swipes this pair). Skip match-creation instead.
    stats.errors++
    logger.warn({ err: reverseErr, fake: fake.id, target: target.id }, 'fake liker: reverse-like check failed')
    return
  }
  if (!reverse) {
    // Fake liked a real user without matching → send the "someone liked you" DM.
    if (target.telegram_id > 0 && target.allows_write_to_pm !== false) {
      notifyNewLike(target.telegram_id, fake.name)
        .catch((err) => logger.warn({ err }, 'fake liker: new-like notify failed'))
    }
    return
  }

  const [u1, u2] = [fake.id, target.id].sort()
  const { data: match, error: matchErr } = await db
    .from('matches')
    .insert({ user1_id: u1, user2_id: u2 })
    .select('id')
    .single()

  if ((matchErr as any)?.code === '23505') return // already matched — no side effects
  if (matchErr || !match) {
    stats.errors++
    logger.warn({ err: matchErr, fake: fake.id, target: target.id }, 'fake liker: match insert failed')
    return
  }
  stats.matchesCreated++

  // Notify the real user only (fakes have a negative sentinel telegram_id).
  if (target.telegram_id > 0 && target.allows_write_to_pm !== false) {
    notifyMatch([{ telegramId: target.telegram_id, matchName: fake.name, matchPhoto: fakePhoto(fake.id) }])
      .catch((err) => logger.warn({ err }, 'fake liker: match notify failed'))
  }
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

  try {
    logger.info({ trigger }, 'fake liker run started')

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
    const fakeIdSet = new Set(fakeIds)

    // --- Seed per-fake like counters from history (for load balancing) ---
    // Per-fake head counts, not a raw-row fetch: an unbounded `select` over every fake
    // like truncates at PostgREST's max-rows cap (~1000) once fakes accumulate that many
    // cumulative likes, skewing balancing. The pool is small (~tens), so per-fake is cheap.
    const counters: Record<string, number> = {}
    for (const f of (pool ?? []) as Array<{ id: string }>) {
      const { count, error: cntErr } = await db
        .from('swipes')
        .select('id', { count: 'exact', head: true })
        .eq('swiper_id', f.id)
        .eq('direction', 'like')
      if (cntErr) {
        logger.warn({ err: cntErr, fake: f.id }, 'fake liker: counter seed failed')
        counters[f.id] = 0
        continue
      }
      counters[f.id] = count ?? 0
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
    const fakeById = new Map(fakes.map((f) => [f.id, f]))

    // Shared per-run budget: warm like-backs are spent first, then cold outreach
    // fills whatever's left — so one run never exceeds cfg.maxTargetsPerRun total.
    let remainingBudget = cfg.maxTargetsPerRun

    // ========================================================================
    // Phase 1 — Like-back: every real user who already liked a fake gets that
    // SAME fake's like back, creating an instant match. These are warm leads
    // (they expressed interest first), so they're processed before cold outreach.
    // The cold path only reaches them by coincidence — same user happening to
    // have zero received likes AND load-balancing happening to pick the very
    // fake they liked — so without this pass most interested users are never
    // matched. The salam phase downstream opens each new match with "salam".
    // ========================================================================
    if (remainingBudget > 0) {
      // Real→fake incoming likes, newest first, deduped by (real, fake) pair.
      const incoming: Array<{ realId: string; fakeId: string }> = []
      const seenPair = new Set<string>()
      let inScanned = 0
      let inOffset = 0
      while (inScanned < SCAN_CAP) {
        const { data: batch, error: inErr } = await db
          .from('swipes')
          .select('swiper_id, swiped_id, created_at')
          .in('swiped_id', fakeIds)
          .eq('direction', 'like')
          .order('created_at', { ascending: false })
          .range(inOffset, inOffset + INCOMING_LIKE_PAGE_SIZE - 1)
        if (inErr) {
          stats.errors++
          logger.warn({ err: inErr }, 'fake liker: incoming-like fetch failed')
          break
        }
        const rows = (batch ?? []) as Array<{ swiper_id: string; swiped_id: string }>
        if (rows.length === 0) break
        inScanned += rows.length
        for (const r of rows) {
          if (fakeIdSet.has(r.swiper_id)) continue // ignore fake→fake likes
          const key = `${r.swiper_id}:${r.swiped_id}`
          if (seenPair.has(key)) continue
          seenPair.add(key)
          incoming.push({ realId: r.swiper_id, fakeId: r.swiped_id })
        }
        if (rows.length < INCOMING_LIKE_PAGE_SIZE) break
        inOffset += INCOMING_LIKE_PAGE_SIZE
      }

      // Existing fake matches per real user — matches involving a fake, deduped by
      // match id (a real↔fake match sits on exactly one query's side; both-fake
      // matches have no real side and are ignored). Feeds both the "already liked
      // back" skip and the per-user cap.
      const matchedPairs = new Set<string>()
      const fakeMatchCountByReal = new Map<string, number>()
      const seenMatchIds = new Set<string>()
      for (const col of ['user1_id', 'user2_id'] as const) {
        const { data: mrows } = await db
          .from('matches')
          .select('id, user1_id, user2_id')
          .in(col, fakeIds)
        for (const m of (mrows ?? []) as Array<{ id: string; user1_id: string; user2_id: string }>) {
          if (seenMatchIds.has(m.id)) continue
          seenMatchIds.add(m.id)
          const u1Fake = fakeIdSet.has(m.user1_id)
          const u2Fake = fakeIdSet.has(m.user2_id)
          if (u1Fake && u2Fake) continue // both-fake → no real side
          const realSide = u1Fake ? m.user2_id : m.user1_id
          const fakeSide = u1Fake ? m.user1_id : m.user2_id
          matchedPairs.add(`${realSide}:${fakeSide}`)
          fakeMatchCountByReal.set(realSide, (fakeMatchCountByReal.get(realSide) ?? 0) + 1)
        }
      }

      // One lead per real user: their newest liked fake that isn't already matched,
      // and only while they're under the fake-match cap. One-per-user = trickle —
      // at most one new fake match per user per run, so matches arrive spread over
      // days rather than all at once, and no user ever exceeds MAX_FAKE_MATCHES_PER_USER.
      const candidateByReal = new Map<string, string>()
      for (const { realId, fakeId } of incoming) {
        if (candidateByReal.has(realId)) continue // already picked this user's lead (newest wins)
        if (matchedPairs.has(`${realId}:${fakeId}`)) continue // already liked back
        if ((fakeMatchCountByReal.get(realId) ?? 0) >= MAX_FAKE_MATCHES_PER_USER) continue // at cap
        candidateByReal.set(realId, fakeId)
      }
      const leads = [...candidateByReal.entries()].map(([realId, fakeId]) => ({ realId, fakeId }))
      if (leads.length > remainingBudget) {
        logger.info(
          { leads: leads.length, budget: remainingBudget },
          'fake liker: like-back leads exceed per-run budget; rest carry to next run',
        )
      }

      // A capped `.in()` (≤ maxTargetsPerRun ids) stays under PostgREST's max-rows cap.
      const slice = leads.slice(0, remainingBudget)
      if (slice.length > 0) {
        const realIds = [...new Set(slice.map((p) => p.realId))]
        const { data: reals, error: realsErr } = await db
          .from('users')
          .select('id, gender, telegram_id, allows_write_to_pm, is_seed, is_active, banned_at, deleted_at')
          .in('id', realIds)
        if (realsErr) {
          stats.errors++
          logger.warn({ err: realsErr }, 'fake liker: like-back real-user fetch failed')
        } else {
          const realById = new Map((reals ?? []).map((u: any) => [u.id, u]))
          for (const { realId, fakeId } of slice) {
            if (remainingBudget <= 0) break
            try {
              const real: any = realById.get(realId)
              if (!real || real.is_seed || !real.is_active || real.banned_at || real.deleted_at) continue
              const fake = fakeById.get(fakeId)
              if (!fake) continue // liked fake is no longer in the active pool → skip
              if (!fakeAllowsGender(fake.looking_for, real.gender)) continue // she isn't looking for that gender

              fake.counter++ // count the assignment immediately so load stays balanced
              await likeTargetAndMatch(
                fake,
                { id: real.id, gender: real.gender, telegram_id: real.telegram_id, allows_write_to_pm: real.allows_write_to_pm },
                fakePhoto,
                stats,
                logger,
              )
              remainingBudget--
            } catch (err) {
              stats.errors++
              logger.warn({ err }, 'fake liker: like-back processing failed')
            }
          }
        }
      }
    }

    // --- Target selection: page through eligible candidates, exclude any with a received like ---
    const cutoff = new Date(Date.now() - FOUR_HOURS_MS).toISOString()
    const targets: Array<{ id: string; gender: string; telegram_id: number; allows_write_to_pm: boolean | null; location: string | null }> = []
    let scanned = 0
    let offset = 0

    while (targets.length < remainingBudget && scanned < SCAN_CAP) {
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
      // Page the received-like lookup fully: a single unbounded `.in()` truncates at
      // PostgREST's max-rows cap, and on truncation/error the batch would look like it has
      // zero received likes (fakes would then like already-liked users). On error we skip
      // the whole batch rather than silently treat it as zero.
      const likedSet = new Set<string>()
      let likedOffset = 0
      let likedFailed = false
      for (;;) {
        const { data: liked, error: likedErr } = await db
          .from('swipes')
          .select('swiped_id')
          .in('swiped_id', ids)
          .eq('direction', 'like')
          .range(likedOffset, likedOffset + RECEIVED_LIKE_PAGE_SIZE - 1)
        if (likedErr) {
          stats.errors++
          logger.warn({ err: likedErr }, 'fake liker: received-like fetch failed')
          likedFailed = true
          break
        }
        const likedRows = (liked ?? []) as Array<{ swiped_id: string }>
        for (const l of likedRows) likedSet.add(l.swiped_id)
        if (likedRows.length < RECEIVED_LIKE_PAGE_SIZE) break
        likedOffset += RECEIVED_LIKE_PAGE_SIZE
      }
      if (likedFailed) {
        // Skip this candidate batch; keep the outer scan advancing exactly as normal.
        if (rows.length < CANDIDATE_BATCH) break
        offset += CANDIDATE_BATCH
        continue
      }

      for (const cand of rows) {
        if (likedSet.has(cand.id)) continue
        targets.push(cand)
        if (targets.length >= remainingBudget) break
      }

      if (rows.length < CANDIDATE_BATCH) break
      offset += CANDIDATE_BATCH
    }

    // --- Cold-outreach like phase: one fake likes each zero-liked target ---
    for (const target of targets) {
      try {
        const compatible = fakes.filter((f) => fakeAllowsGender(f.looking_for, target.gender))
        if (compatible.length === 0) continue

        const fake = pickFake(compatible, target.location)
        fake.counter++ // count the assignment immediately so load stays balanced

        await likeTargetAndMatch(fake, target, fakePhoto, stats, logger)
      } catch (err) {
        stats.errors++
        logger.warn({ err }, 'fake liker: target processing failed')
      }
    }

    // --- Salam phase: open every fake-involved match with "salam" if it has no messages yet ---
    // Runs every time (independent of the like phase) so it also seeds matches the real
    // swipe route created. Two `.in` queries + dedupe stand in for an OR anti-join.
    const matchMap = new Map<string, { id: string; user1_id: string; user2_id: string; created_at: string }>()
    for (const col of ['user1_id', 'user2_id'] as const) {
      const { data: rows } = await db
        .from('matches')
        .select('id, user1_id, user2_id, created_at')
        .in(col, fakeIds)
        .order('created_at', { ascending: false })
        .limit(SALAM_CAP)
      for (const m of (rows ?? []) as Array<{ id: string; user1_id: string; user2_id: string; created_at: string }>) {
        matchMap.set(m.id, m)
      }
    }
    // Each query returns its own newest-200 window; merging can exceed the cap, so
    // re-sort by recency and apply the cap on recency (not query-arrival order) —
    // the newest matches (most likely to still need their first salam) always win.
    const candidateMatches = [...matchMap.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, SALAM_CAP)

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

      // Which candidate matches are truly zero-message? Per-match head counts, not a
      // single unbounded `.in()`: on truncation/error that membership query would make
      // matches with an active conversation look zero-message, so the fake would send
      // "salam" into it every run. On a count error we SKIP that match (never treat the
      // error as "no messages"); a match only qualifies when its count is confirmed 0.
      const zeroMessageMatchIds = new Set<string>()
      for (const m of candidateMatches) {
        const { count, error: countErr } = await db
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('match_id', m.id)
        if (countErr) {
          stats.errors++
          logger.warn({ err: countErr, match: m.id }, 'fake liker: message-count query failed')
          continue
        }
        if ((count ?? 0) === 0) zeroMessageMatchIds.add(m.id)
      }

      for (const m of candidateMatches) {
        try {
          const u1Fake = fakeIdSet.has(m.user1_id)
          const u2Fake = fakeIdSet.has(m.user2_id)
          if (u1Fake && u2Fake) continue // both-fake → skip

          const fakeId = u1Fake ? m.user1_id : m.user2_id
          const realId = u1Fake ? m.user2_id : m.user1_id
          const real: any = realMap.get(realId)
          if (!real || real.deleted_at || real.banned_at) continue // real side gone → skip
          if (!zeroMessageMatchIds.has(m.id)) continue // has messages, or count errored → skip

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

          // Offline-notify the real user (shared delivery logic).
          void deliverMessageNotification(
            { id: realId, telegram_id: real.telegram_id, last_active: real.last_active, notified_offline_at: real.notified_offline_at, allows_write_to_pm: real.allows_write_to_pm },
            fakeId,
            fake.name,
            'salam',
            logger,
          )
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
      const { error: runErr } = await db.from('fake_liker_runs').insert({
        trigger,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        likes_sent: stats.likesSent,
        matches_created: stats.matchesCreated,
        salams_sent: stats.salamsSent,
        errors: stats.errors,
      })
      // supabase-js resolves (never throws) on a failed insert — the surrounding
      // try/catch alone would let the failure pass silently.
      if (runErr) logger.warn({ err: runErr }, 'fake liker: run row insert failed')
    } catch (err) {
      logger.warn({ err }, 'fake liker: run row insert failed')
    }
    running = false
    logger.info({ ...stats }, 'fake liker run finished')
  }
}
