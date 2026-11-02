import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Another area's module: the toggle read is stubbed so each test controls it.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { isPremiumEnabled } from '../src/premium/service.js'
import { SWIPE_WINDOW_MS, checkAndCountSwipe, getSwipeLimitStatus } from '../src/premium/swipeLimit.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { usersUpdateFault, clearUsersUpdateFault } from './helpers/swipeLimit.js'

const NOW = new Date('2026-08-07T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()
const start = iso(NOW - 60_000)
const RESET_AT = iso(NOW - 60_000 + SWIPE_WINDOW_MS)

const LIMITED_USER = {
  gender: 'man', looking_for: 'women', premium_until: null,
  swipe_window_started_at: start, swipe_window_count: 20,
}

const rowOf = async (id: string) =>
  (await sql`select swipe_window_count, bonus_swipes from users where id = ${id}`)[0]

/** Runs while the toggle is read — i.e. between the limit's read and its guarded write. */
function concurrently(fn: () => Promise<unknown>) {
  vi.mocked(isPremiumEnabled).mockImplementationOnce(async () => {
    await fn()
    return true
  })
}

beforeEach(async () => {
  await resetDb()
  vi.mocked(isPremiumEnabled).mockResolvedValue(true)
})
afterEach(async () => {
  await clearUsersUpdateFault()
})

describe('checkAndCountSwipe — bonus swipes', () => {
  it('consumes a bonus swipe when the window is exhausted', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 3 })
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: { remaining: 2, resetAt: RESET_AT } })
    expect(await rowOf(u.id)).toEqual({ swipe_window_count: 20, bonus_swipes: 2 })
  })

  it('blocks when the window is exhausted and there are no bonus swipes', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 0 })
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: true, resetAt: RESET_AT })
    expect(await rowOf(u.id)).toEqual({ swipe_window_count: 20, bonus_swipes: 0 })
  })

  it('consumes a bonus swipe on the window-counter race retry path when the retry re-read is also at the limit', async () => {
    // Initial read sees count=19 (one swipe left), so the main window branch
    // attempts to count this swipe normally. A concurrent writer pushes the
    // count to the limit (20) before our guarded update lands, so the first
    // guardedWindowUpdate loses the race. The retry re-read sees count=20 (now
    // blocked) — this must route through bonus consumption too, symmetric with
    // the main branch, instead of blocking outright.
    const u = await createUser({ ...LIMITED_USER, swipe_window_count: 19, bonus_swipes: 2 })
    concurrently(() => sql`update users set swipe_window_count = 20 where id = ${u.id}`)
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: { remaining: 1, resetAt: RESET_AT } })
    expect(await rowOf(u.id)).toEqual({ swipe_window_count: 20, bonus_swipes: 1 })
  })

  it('blocks when the bonus retry re-read shows bonus swipes genuinely exhausted', async () => {
    // The first guarded bonus decrement loses the race; the retry re-read shows
    // bonus_swipes dropped to 0 (a concurrent request spent it), so this swipe
    // blocks rather than attempting a second decrement.
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 2 })
    concurrently(() => sql`update users set bonus_swipes = 0 where id = ${u.id}`)
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: true, resetAt: RESET_AT })
    expect((await rowOf(u.id)).bonus_swipes).toBe(0)
  })

  it('retries the bonus decrement against the fresh count after losing once', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 3 })
    concurrently(() => sql`update users set bonus_swipes = 2 where id = ${u.id}`)
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: { remaining: 1, resetAt: RESET_AT } })
    expect((await rowOf(u.id)).bonus_swipes).toBe(1)
  })

  it('fails open (not blocked) when the guarded bonus decrement loses the race twice', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 3 })
    await usersUpdateFault('skip') // every guarded write matches no row
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
    expect((await rowOf(u.id)).bonus_swipes).toBe(3)
  })

  it('fails open when the bonus decrement errors', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 3 })
    await usersUpdateFault('fail')
    expect(await checkAndCountSwipe(u.id, NOW)).toEqual({ blocked: false, swipeLimit: null })
  })
})

describe('getSwipeLimitStatus — bonus swipes', () => {
  it('is not limited when the window is exhausted but bonus swipes remain', async () => {
    const u = await createUser({ ...LIMITED_USER, bonus_swipes: 1 })
    expect(await getSwipeLimitStatus(u.id, NOW)).toEqual({ limited: false, resetAt: null })
    expect((await rowOf(u.id)).bonus_swipes).toBe(1)
  })
})
