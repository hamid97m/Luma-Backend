import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Another area's module: the toggle read is stubbed so each test controls it.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { isPremiumEnabled } from '../src/premium/service.js'
import {
  SWIPE_LIMIT, SWIPE_WINDOW_MS,
  swipeLimitApplies, evaluateSwipeWindow, checkAndCountSwipe, getSwipeLimitStatus,
} from '../src/premium/swipeLimit.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { usersUpdateFault, clearUsersUpdateFault } from './helpers/swipeLimit.js'

const NOW = new Date('2026-08-07T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('swipeLimitApplies', () => {
  it('applies to men and women whose preference includes women', () => {
    expect(swipeLimitApplies('man', 'women')).toBe(true)
    expect(swipeLimitApplies('man', 'both')).toBe(true)
    expect(swipeLimitApplies('man', 'everyone')).toBe(true)
    expect(swipeLimitApplies('woman', 'women')).toBe(true)
    expect(swipeLimitApplies('woman', 'both')).toBe(true)
    expect(swipeLimitApplies('woman', 'everyone')).toBe(true)
  })
  it('exempts everyone else', () => {
    expect(swipeLimitApplies('man', 'men')).toBe(false)
    expect(swipeLimitApplies('woman', 'men')).toBe(false)
    expect(swipeLimitApplies('nonbinary', 'women')).toBe(false)
    expect(swipeLimitApplies(null, 'women')).toBe(false)
    expect(swipeLimitApplies('man', null)).toBe(false)
  })
})

describe('evaluateSwipeWindow', () => {
  it('starts a fresh window on the first-ever swipe', () => {
    const w = evaluateSwipeWindow(null, 0, NOW)
    expect(w).toEqual({
      blocked: false,
      resetAt: iso(NOW + SWIPE_WINDOW_MS),
      nextStartedAt: iso(NOW),
      nextCount: 1,
      remaining: SWIPE_LIMIT - 1,
    })
  })

  it('starts a fresh window when the previous one expired', () => {
    const staleStart = iso(NOW - SWIPE_WINDOW_MS - 1000)
    const w = evaluateSwipeWindow(staleStart, 20, NOW)
    expect(w.blocked).toBe(false)
    expect(w.nextStartedAt).toBe(iso(NOW))
    expect(w.nextCount).toBe(1)
    expect(w.remaining).toBe(SWIPE_LIMIT - 1)
  })

  it('increments inside an active window', () => {
    const start = iso(NOW - 60_000)
    const w = evaluateSwipeWindow(start, 5, NOW)
    expect(w).toEqual({
      blocked: false,
      resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS),
      nextStartedAt: start,
      nextCount: 6,
      remaining: SWIPE_LIMIT - 6,
    })
  })

  it('reports remaining 0 on the 20th swipe and blocks the 21st', () => {
    const start = iso(NOW - 60_000)
    const twentieth = evaluateSwipeWindow(start, 19, NOW)
    expect(twentieth.blocked).toBe(false)
    expect(twentieth.remaining).toBe(0)

    const twentyFirst = evaluateSwipeWindow(start, 20, NOW)
    expect(twentyFirst).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
  })
})

const LIMITED_USER = {
  gender: 'man', looking_for: 'women', premium_until: null,
  swipe_window_started_at: null, swipe_window_count: 0,
}

const windowOf = async (id: string) =>
  (await sql`select swipe_window_started_at, swipe_window_count, bonus_swipes from users where id = ${id}`)[0]

/** While the toggle is read (between the limit's read and its guarded write),
 *  a concurrent request bumps the counter — the write then loses the race. */
function concurrentWriterSets(id: string, count: number) {
  vi.mocked(isPremiumEnabled).mockImplementationOnce(async () => {
    await sql`update users set swipe_window_count = ${count} where id = ${id}`
    return true
  })
}

beforeEach(async () => {
  await resetDb()
})
afterEach(async () => {
  await clearUsersUpdateFault()
})

describe('checkAndCountSwipe', () => {
  it('counts the swipe and returns remaining for a limited free man', async () => {
    const u = await createUser(LIMITED_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe(u.id, NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: { remaining: SWIPE_LIMIT - 1, resetAt: iso(NOW + SWIPE_WINDOW_MS) } })
    expect(await windowOf(u.id)).toMatchObject({ swipe_window_started_at: iso(NOW), swipe_window_count: 1 })
  })

  it('increments inside an active window', async () => {
    const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 5 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe(u.id, NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: { remaining: SWIPE_LIMIT - 6, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) } })
    expect(await windowOf(u.id)).toMatchObject({ swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 6 })
  })

  it('blocks at the limit inside an active window', async () => {
    const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 20 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe(u.id, NOW)
    expect(res).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
    expect((await windowOf(u.id)).swipe_window_count).toBe(20)
  })

  it('is exempt (no counting) when the premium toggle is off', async () => {
    const u = await createUser(LIMITED_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
    expect((await windowOf(u.id)).swipe_window_count).toBe(0)
  })

  it('is exempt when the user is premium-active', async () => {
    const u = await createUser({ ...LIMITED_USER, premium_until: iso(NOW + 1000 * 60) })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
  })

  it('is exempt for a woman seeking only men (never touches the toggle)', async () => {
    const u = await createUser({ ...LIMITED_USER, gender: 'woman', looking_for: 'men' })
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('fails open when the user select errors (malformed id)', async () => {
    expect(await checkAndCountSwipe('u1', NOW)).toEqual({ blocked: false, swipeLimit: null })
  })

  it('fails open for a missing user', async () => {
    expect(await checkAndCountSwipe('00000000-0000-0000-0000-000000000000', NOW)).toEqual({ blocked: false, swipeLimit: null })
  })

  it('fails open (allows, no limit info) when the counter update errors', async () => {
    const u = await createUser(LIMITED_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    await usersUpdateFault('fail')
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
  })

  describe('optimistic-concurrency retry', () => {
    const start = iso(NOW - 60_000)

    it('retries and succeeds when the guarded update loses the race once', async () => {
      // Initial read sees count=5; a concurrent writer bumps it to 6 before our
      // guarded update runs, so the first attempt (expecting 5) loses. The retry
      // re-read sees 6, re-evaluates (still under the limit), and the second
      // guarded update (expecting 6) succeeds.
      const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 5 })
      concurrentWriterSets(u.id, 6)
      const res = await checkAndCountSwipe(u.id, NOW)
      expect(res).toEqual({
        blocked: false,
        swipeLimit: { remaining: SWIPE_LIMIT - 7, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) },
      })
      expect((await windowOf(u.id)).swipe_window_count).toBe(7)
    })

    it('fails open when the guarded update loses the race twice', async () => {
      const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 5 })
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      await usersUpdateFault('skip') // every guarded write matches no row
      expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
      expect((await windowOf(u.id)).swipe_window_count).toBe(5)
    })

    it('blocks when the retry re-read shows the count now at the limit', async () => {
      // Initial read sees count=19 (one swipe left); a concurrent writer pushes
      // it to the limit (20) before our guarded update lands, so the retry
      // re-evaluation blocks instead of attempting a second update.
      const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 19 })
      concurrentWriterSets(u.id, 20)
      expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
      expect((await windowOf(u.id)).swipe_window_count).toBe(20)
    })

    it('two truly concurrent swipes at count 19 never both pass', async () => {
      const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 19 })
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      const results = await Promise.all([checkAndCountSwipe(u.id, NOW), checkAndCountSwipe(u.id, NOW)])
      expect(results.filter((r) => !r.blocked && r.swipeLimit)).toHaveLength(1)
      expect((await windowOf(u.id)).swipe_window_count).toBe(20)
    })
  })
})

describe('getSwipeLimitStatus', () => {
  it('reports limited with resetAt when the window is exhausted', async () => {
    const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 20 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getSwipeLimitStatus(u.id, NOW)).toEqual({ limited: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
  })

  it('reports not limited mid-window and for exempt users, and never counts', async () => {
    const u = await createUser({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 3 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getSwipeLimitStatus(u.id, NOW)).toEqual({ limited: false, resetAt: null })
    expect((await windowOf(u.id)).swipe_window_count).toBe(3)

    const w = await createUser({ ...LIMITED_USER, gender: 'woman', looking_for: 'men' })
    expect(await getSwipeLimitStatus(w.id, NOW)).toEqual({ limited: false, resetAt: null })
  })

  it('fails open on db error (malformed id)', async () => {
    expect(await getSwipeLimitStatus('u1', NOW)).toEqual({ limited: false, resetAt: null })
  })
})
