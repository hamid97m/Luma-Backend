import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { db } from '../src/db.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import { SWIPE_WINDOW_MS, checkAndCountSwipe, getSwipeLimitStatus } from '../src/premium/swipeLimit.js'

const NOW = new Date('2026-08-07T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()
const start = iso(NOW - 60_000)
const RESET_AT = iso(NOW - 60_000 + SWIPE_WINDOW_MS)

const LIMITED_USER = {
  gender: 'man', looking_for: 'women', premium_until: null,
  swipe_window_started_at: start, swipe_window_count: 20,
}

/**
 * Mocks the `users` table across a mix of select().eq().single() calls
 * (loadLimitedUser, and the bonus retry re-read) and
 * update().eq().eq().select() calls (guardedBonusUpdate), each driven by
 * an ordered sequence so tests can script races.
 */
function mockBonusScenario(opts: {
  selects: Array<{ data: any; error?: any }>
  updates: Array<{ data: any; error?: any }>
  captured?: Array<{ patch: any; eqArgs: any[][] }>
}) {
  let selectCall = 0
  let updateCall = 0
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table !== 'users') throw new Error(`unexpected table ${table}`)
    return {
      select: () => ({
        eq: () => ({
          single: () => {
            const res = opts.selects[Math.min(selectCall, opts.selects.length - 1)]
            selectCall++
            return res
          },
        }),
      }),
      update: (patch: any) => {
        const eqArgs: any[][] = []
        const chain: any = {
          eq: (...args: any[]) => { eqArgs.push(args); return chain },
          select: () => {
            const res = opts.updates[Math.min(updateCall, opts.updates.length - 1)]
            updateCall++
            opts.captured?.push({ patch, eqArgs })
            return res
          },
        }
        return chain
      },
    }
  }) as any)
}

describe('checkAndCountSwipe — bonus swipes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('consumes a bonus swipe when the window is exhausted', async () => {
    const captured: Array<{ patch: any; eqArgs: any[][] }> = []
    mockBonusScenario({
      selects: [{ data: { ...LIMITED_USER, bonus_swipes: 3 }, error: null }],
      updates: [{ data: [{ id: 'u1' }], error: null }],
      captured,
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await checkAndCountSwipe('u1', NOW)

    expect(res).toEqual({ blocked: false, swipeLimit: { remaining: 2, resetAt: RESET_AT } })
    expect(captured).toHaveLength(1)
    expect(captured[0].patch).toEqual({ bonus_swipes: 2 })
    expect(captured[0].eqArgs).toContainEqual(['id', 'u1'])
    expect(captured[0].eqArgs).toContainEqual(['bonus_swipes', 3])
  })

  it('blocks when the window is exhausted and there are no bonus swipes', async () => {
    mockBonusScenario({
      selects: [{ data: { ...LIMITED_USER, bonus_swipes: 0 }, error: null }],
      updates: [],
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await checkAndCountSwipe('u1', NOW)

    expect(res).toEqual({ blocked: true, resetAt: RESET_AT })
  })

  it('consumes a bonus swipe on the window-counter race retry path when the retry re-read is also at the limit', async () => {
    // Initial read sees count=19 (one swipe left), so the main window
    // branch attempts to count this swipe normally. A concurrent writer
    // pushes the count to the limit (20) before our guarded update lands,
    // so the first guardedWindowUpdate loses the race. The retry re-read
    // sees count=20 (now blocked) — this must route through bonus
    // consumption too, symmetric with the main branch, instead of blocking
    // outright.
    const captured: Array<{ patch: any; eqArgs: any[][] }> = []
    mockBonusScenario({
      selects: [
        { data: { ...LIMITED_USER, swipe_window_count: 19, bonus_swipes: 2 }, error: null }, // initial load
        { data: { ...LIMITED_USER, swipe_window_count: 20, bonus_swipes: 2 }, error: null }, // retry re-read, now at limit
      ],
      updates: [
        { data: [], error: null }, // guardedWindowUpdate loses the race
        { data: [{ id: 'u1' }], error: null }, // guardedBonusUpdate succeeds
      ],
      captured,
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await checkAndCountSwipe('u1', NOW)

    expect(res).toEqual({ blocked: false, swipeLimit: { remaining: 1, resetAt: RESET_AT } })
    // First update attempted the window counter, second the bonus decrement.
    expect(captured).toHaveLength(2)
    expect(captured[0].patch).toEqual({ swipe_window_started_at: start, swipe_window_count: 20 })
    expect(captured[1].patch).toEqual({ bonus_swipes: 1 })
    expect(captured[1].eqArgs).toContainEqual(['id', 'u1'])
    expect(captured[1].eqArgs).toContainEqual(['bonus_swipes', 2])
  })

  it('blocks when the bonus retry re-read shows bonus swipes genuinely exhausted', async () => {
    // First guardedBonusUpdate loses the race; the retry re-read shows
    // bonus_swipes has actually dropped to 0 (a concurrent request spent
    // it), so this swipe blocks rather than attempting a second decrement.
    mockBonusScenario({
      selects: [
        { data: { ...LIMITED_USER, bonus_swipes: 2 }, error: null }, // initial load, window already at limit
        { data: { bonus_swipes: 0 }, error: null }, // retry re-read, bonus now exhausted
      ],
      updates: [
        { data: [], error: null }, // first guarded bonus update loses the race
      ],
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await checkAndCountSwipe('u1', NOW)

    expect(res).toEqual({ blocked: true, resetAt: RESET_AT })
  })

  it('fails open (not blocked) when the guarded bonus decrement loses the race twice', async () => {
    mockBonusScenario({
      selects: [
        { data: { ...LIMITED_USER, bonus_swipes: 3 }, error: null }, // initial load
        { data: { bonus_swipes: 3 }, error: null }, // retry re-read, still has bonus
      ],
      updates: [
        { data: [], error: null }, // first guarded update loses the race
        { data: [], error: null }, // retry guarded update also loses the race
      ],
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await checkAndCountSwipe('u1', NOW)

    expect(res).toEqual({ blocked: false, swipeLimit: null })
  })
})

describe('getSwipeLimitStatus — bonus swipes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is not limited when the window is exhausted but bonus swipes remain', async () => {
    mockBonusScenario({
      selects: [{ data: { ...LIMITED_USER, bonus_swipes: 1 }, error: null }],
      updates: [],
    })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)

    const res = await getSwipeLimitStatus('u1', NOW)

    expect(res).toEqual({ limited: false, resetAt: null })
  })
})
