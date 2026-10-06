import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyNewLike: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/likes/service.js', () => ({ getIncomingLikers: vi.fn() }))

import { db } from '../src/db.js'
import { notifyNewLike } from '../src/bot.js'
import { getIncomingLikers } from '../src/likes/service.js'
import { ensureDailyReveal, hiddenIncomingLikerIds } from '../src/likes/reveal.js'
import { chainable } from './admin-helpers.js'

const NOW = new Date('2026-10-07T10:00:00.000Z') // Tehran date 2026-10-07
const WOMAN = 'woman-1'

function liker(id: string, likedAt: string) {
  return {
    id, name: id, age: 30, bio: null, location: null, interests: [],
    telegramId: 100, gender: 'man', likedAt, premium: false,
  }
}

function userRow(id: string, opts: { geoCity?: string | null; lastActive?: string; isSeed?: boolean; pausedAt?: string | null } = {}) {
  return {
    id,
    geo_city: opts.geoCity ?? 'Tehran',
    last_active: opts.lastActive ?? '2026-10-07T08:00:00.000Z',
    is_seed: opts.isSeed ?? false,
    paused_at: opts.pausedAt ?? null,
    deleted_at: null,
    banned_at: null,
    name: id,
    telegram_id: 50,
    allows_write_to_pm: true,
    locale: 'fa',
  }
}

/**
 * db.from sequence inside one ensureDailyReveal call:
 * 1. users (the woman)
 * 2. like_reveals (latest row, maybe null)
 * 3. swipes (has she swiped the current reveal?) — only when a row exists
 * Then, when picking:
 * 4. users (candidate rows)
 * 5. user_photos
 * 6. like_reveals insert
 * 7. like_reveals update notified_at
 */
function mockWoman(opts: {
  reveals?: any[]
  swipedReveal?: boolean
  candidates?: any[]
  photos?: Array<{ user_id: string }>
  write?: boolean
}) {
  const queues: Record<string, any[]> = {
    users: [
      chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran', telegram_id: 9, allows_write_to_pm: opts.write !== false, locale: 'fa' } }),
      chainable({ data: opts.candidates ?? [] }),
      chainable({ data: { name: opts.candidates?.[0]?.id ?? '' } }),
    ],
    like_reveals: [
      chainable({ data: opts.reveals ?? [] }),
      chainable({ data: [{ user_id: WOMAN }], error: null }),
      chainable({ data: null, error: null }),
    ],
    swipes: [chainable({ data: opts.swipedReveal ? [{ swiped_id: 'kept' }] : [] })],
    user_photos: [chainable({ data: opts.photos ?? [] })],
  }
  vi.mocked(db.from).mockImplementation((table: string) => {
    const q = queues[table]
    if (!q?.length) return chainable({ data: [], error: null })
    return q.shift()
  })
}

describe('ensureDailyReveal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not apply to a man', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: { id: 'man-1', gender: 'man' } })
      return chainable({ data: [] })
    })
    await expect(ensureDailyReveal('man-1', NOW)).resolves.toEqual({ applies: false })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('picks the eligible liker, stores the row, and DMs once', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([liker('ali', '2026-10-01T00:00:00.000Z')] as any)
    mockWoman({
      candidates: [userRow('ali', { lastActive: '2026-10-07T09:00:00.000Z' })],
      photos: [{ user_id: 'ali' }],
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(notifyNewLike).toHaveBeenCalledWith(9, 'ali', 'fa')
  })

  it('returns the same person without a second DM', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran' } })
      if (table === 'like_reveals') return chainable({ data: [{ swiper_id: 'ali', revealed_on: '2026-10-07', notified_at: '2026-10-07T09:00:00.000Z' }] })
      if (table === 'swipes') return chainable({ data: [] })
      return chainable({ data: [] })
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(getIncomingLikers).not.toHaveBeenCalled()
  })

  it('keeps an unanswered reveal from yesterday and does not DM again', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran' } })
      if (table === 'like_reveals') return chainable({ data: [{ swiper_id: 'ali', revealed_on: '2026-10-06', notified_at: '2026-10-06T14:30:00.000Z' }] })
      if (table === 'swipes') return chainable({ data: [] })
      return chainable({ data: [] })
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('shows nobody for the rest of the day after she passes him', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran' } })
      if (table === 'like_reveals') return chainable({ data: [{ swiper_id: 'ali', revealed_on: '2026-10-07', notified_at: 'x' }] })
      if (table === 'swipes') return chainable({ data: [{ swiped_id: 'ali' }] })
      return chainable({ data: [] })
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: null })
    expect(getIncomingLikers).not.toHaveBeenCalled()
  })

  it('picks the next queued person on the next Tehran day', async () => {
    const nextDay = new Date('2026-10-07T21:00:00.000Z') // Tehran 2026-10-08 00:30
    vi.mocked(getIncomingLikers).mockResolvedValue([
      liker('reza', '2026-10-02T00:00:00.000Z'),
    ] as any)
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        const calls = vi.mocked(db.from).mock.calls.filter((c) => c[0] === 'users').length
        if (calls === 1) return chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran', telegram_id: 9, allows_write_to_pm: true, locale: 'fa' } })
        if (calls === 2) return chainable({ data: [userRow('reza', { lastActive: '2026-10-07T11:00:00.000Z' })] })
        return chainable({ data: { name: 'reza' } })
      }
      if (table === 'like_reveals') {
        const calls = vi.mocked(db.from).mock.calls.filter((c) => c[0] === 'like_reveals').length
        if (calls === 1) return chainable({ data: [{ swiper_id: 'ali', revealed_on: '2026-10-07', notified_at: 'x' }] })
        return chainable({ data: [{ user_id: WOMAN }], error: null })
      }
      if (table === 'swipes') return chainable({ data: [{ swiped_id: 'ali' }] })
      if (table === 'user_photos') return chainable({ data: [{ user_id: 'reza' }] })
      return chainable({ data: [] })
    })
    await expect(ensureDailyReveal(WOMAN, nextDay)).resolves.toEqual({ applies: true, swiperId: 'reza' })
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
  })

  it('never chooses a seed', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([liker('fake', '2026-10-01T00:00:00.000Z')] as any)
    mockWoman({
      candidates: [userRow('fake', { isSeed: true })],
      photos: [{ user_id: 'fake' }],
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: null })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('stores the row and skips the DM when she has refused bot writes', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([liker('ali', '2026-10-01T00:00:00.000Z')] as any)
    mockWoman({
      write: false,
      candidates: [userRow('ali')],
      photos: [{ user_id: 'ali' }],
    })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('still returns the reveal when the like DM fails', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([liker('ali', '2026-10-01T00:00:00.000Z')] as any)
    vi.mocked(notifyNewLike).mockRejectedValue(new Error('Telegram down'))
    mockWoman({
      candidates: [userRow('ali', { lastActive: '2026-10-07T09:00:00.000Z' })],
      photos: [{ user_id: 'ali' }],
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('hiddenIncomingLikerIds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hides every incoming liker except the revealed one', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([liker('ali', 'a'), liker('reza', 'b')] as any)
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: { id: WOMAN, gender: 'woman', geo_city: 'Tehran' } })
      if (table === 'like_reveals') return chainable({ data: [{ swiper_id: 'ali', revealed_on: '2026-10-07', notified_at: 'x' }] })
      if (table === 'swipes') return chainable({ data: [] })
      return chainable({ data: [] })
    })
    await expect(hiddenIncomingLikerIds(WOMAN, NOW)).resolves.toEqual(['reza'])
  })
})
