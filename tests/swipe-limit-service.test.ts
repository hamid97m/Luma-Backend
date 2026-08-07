import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { db } from '../src/db.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import {
  SWIPE_LIMIT, SWIPE_WINDOW_MS,
  swipeLimitApplies, evaluateSwipeWindow, checkAndCountSwipe, getSwipeLimitStatus,
} from '../src/premium/swipeLimit.js'

const NOW = new Date('2026-08-07T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('swipeLimitApplies', () => {
  it('applies to men whose preference includes women', () => {
    expect(swipeLimitApplies('man', 'women')).toBe(true)
    expect(swipeLimitApplies('man', 'both')).toBe(true)
    expect(swipeLimitApplies('man', 'everyone')).toBe(true)
  })
  it('exempts everyone else', () => {
    expect(swipeLimitApplies('man', 'men')).toBe(false)
    expect(swipeLimitApplies('woman', 'women')).toBe(false)
    expect(swipeLimitApplies('woman', 'everyone')).toBe(false)
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

/** users-select then users-guarded-update chain mock for checkAndCountSwipe. */
function mockUserRow(row: Record<string, unknown> | null, opts?: { selectError?: boolean; updateError?: boolean; onUpdate?: (patch: any) => void }) {
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table !== 'users') throw new Error(`unexpected table ${table}`)
    return {
      select: () => ({ eq: () => ({ single: () => (opts?.selectError ? { data: null, error: { message: 'boom' } } : { data: row, error: null }) }) }),
      update: (patch: any) => {
        opts?.onUpdate?.(patch)
        return {
          eq: () => ({
            eq: () => ({
              select: () => (opts?.updateError
                ? { data: null, error: { message: 'boom' } }
                : { data: [{ id: 'u1' }], error: null }),
            }),
          }),
        }
      },
    }
  }) as any)
}

/**
 * users-select then a guarded-update chain whose select() result is driven
 * by a per-call sequence — lets tests simulate a first update losing the
 * optimistic-concurrency race and a retry re-read seeing a fresh count.
 */
function mockUserRowSequence(
  selects: Array<Record<string, unknown> | null>,
  updates: Array<{ data: Array<{ id: string }> | null; error?: { message: string } | null }>,
) {
  let selectCall = 0
  let updateCall = 0
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table !== 'users') throw new Error(`unexpected table ${table}`)
    return {
      select: () => ({
        eq: () => ({
          single: () => {
            const row = selects[Math.min(selectCall, selects.length - 1)]
            selectCall++
            return { data: row, error: null }
          },
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => {
              const res = updates[Math.min(updateCall, updates.length - 1)]
              updateCall++
              return { data: res.data, error: res.error ?? null }
            },
          }),
        }),
      }),
    }
  }) as any)
}

const LIMITED_USER = {
  gender: 'man', looking_for: 'women', premium_until: null,
  swipe_window_started_at: null, swipe_window_count: 0,
}

describe('checkAndCountSwipe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts the swipe and returns remaining for a limited free man', async () => {
    let written: any
    mockUserRow(LIMITED_USER, { onUpdate: (p) => { written = p } })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: { remaining: SWIPE_LIMIT - 1, resetAt: iso(NOW + SWIPE_WINDOW_MS) } })
    expect(written).toEqual({ swipe_window_started_at: iso(NOW), swipe_window_count: 1 })
  })

  it('blocks at the limit inside an active window', async () => {
    mockUserRow({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 20 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
  })

  it('is exempt (no counting) when the premium toggle is off', async () => {
    mockUserRow(LIMITED_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: null })
  })

  it('is exempt when the user is premium-active', async () => {
    mockUserRow({ ...LIMITED_USER, premium_until: iso(NOW + 1000 * 60) })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: null })
  })

  it('is exempt for a woman regardless of preference (never touches the toggle)', async () => {
    mockUserRow({ ...LIMITED_USER, gender: 'woman' })
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: null })
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('fails open when the user select errors', async () => {
    mockUserRow(null, { selectError: true })
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: null })
  })

  it('fails open (allows, no limit info) when the counter update errors', async () => {
    mockUserRow(LIMITED_USER, { updateError: true })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountSwipe('u1', NOW)
    expect(res).toEqual({ blocked: false, swipeLimit: null })
  })

  describe('optimistic-concurrency retry', () => {
    const start = iso(NOW - 60_000)

    it('retries and succeeds when the guarded update loses the race once', async () => {
      // Initial read sees count=5; a concurrent writer bumps it to 6 before
      // our guarded update runs, so the first attempt (expecting 5) loses.
      // The retry re-read sees 6, re-evaluates (still under the limit), and
      // the second guarded update (expecting 6) succeeds.
      mockUserRowSequence(
        [{ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 5 },
         { ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 6 }],
        [{ data: [] }, { data: [{ id: 'u1' }] }],
      )
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      const res = await checkAndCountSwipe('u1', NOW)
      expect(res).toEqual({
        blocked: false,
        swipeLimit: { remaining: SWIPE_LIMIT - 7, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) },
      })
    })

    it('fails open when the guarded update loses the race twice', async () => {
      mockUserRowSequence(
        [{ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 5 },
         { ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 6 }],
        [{ data: [] }, { data: [] }],
      )
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      const res = await checkAndCountSwipe('u1', NOW)
      expect(res).toEqual({ blocked: false, swipeLimit: null })
    })

    it('blocks when the retry re-read shows the count now at the limit', async () => {
      // Initial read sees count=19 (one swipe left); a concurrent writer
      // pushes it to the limit (20) before our guarded update lands, so the
      // retry re-evaluation blocks instead of attempting a second update.
      mockUserRowSequence(
        [{ ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 19 },
         { ...LIMITED_USER, swipe_window_started_at: start, swipe_window_count: 20 }],
        [{ data: [] }],
      )
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      const res = await checkAndCountSwipe('u1', NOW)
      expect(res).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
    })
  })
})

describe('getSwipeLimitStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports limited with resetAt when the window is exhausted', async () => {
    mockUserRow({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 20 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await getSwipeLimitStatus('u1', NOW)
    expect(res).toEqual({ limited: true, resetAt: iso(NOW - 60_000 + SWIPE_WINDOW_MS) })
  })

  it('reports not limited mid-window and for exempt users', async () => {
    mockUserRow({ ...LIMITED_USER, swipe_window_started_at: iso(NOW - 60_000), swipe_window_count: 3 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getSwipeLimitStatus('u1', NOW)).toEqual({ limited: false, resetAt: null })

    mockUserRow({ ...LIMITED_USER, gender: 'woman' })
    expect(await getSwipeLimitStatus('u1', NOW)).toEqual({ limited: false, resetAt: null })
  })

  it('fails open on db error', async () => {
    mockUserRow(null, { selectError: true })
    expect(await getSwipeLimitStatus('u1', NOW)).toEqual({ limited: false, resetAt: null })
  })
})
