import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/likes/service.js', () => ({ getIncomingLikers: vi.fn(), getIncomingLiker: vi.fn() }))
vi.mock('../src/likes/reveal.js', () => ({
  ensureDailyReveal: vi.fn().mockResolvedValue({ applies: false }),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getIncomingLikers, getIncomingLiker } from '../src/likes/service.js'
import { ensureDailyReveal } from '../src/likes/reveal.js'
import { chainable } from './admin-helpers.js'

const woman = { id: 'w1', name: 'Sara', age: 27, bio: null, location: 'Tehran', interests: ['Yoga'], telegramId: 2, gender: 'woman', likedAt: '2026-08-08T00:00:00Z' }
const man = { id: 'm1', name: 'Ali', age: 30, bio: 'hi', location: 'Shiraz', interests: ['Hiking', 'Music'], telegramId: 3, gender: 'man', likedAt: '2026-08-07T00:00:00Z' }

function mockDb(opts: { enabled: boolean; myPremiumUntil: string | null; seenAt?: string | null }) {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Me' } as any)
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return chainable({ data: { id: 'me', premium_until: opts.myPremiumUntil, likes_seen_at: opts.seenAt ?? null } })
    if (table === 'premium_config') return chainable({ data: { premium_enabled: opts.enabled } })
    if (table === 'user_photos') return chainable({ data: [
      { user_id: 'm1', url: 'http://p/m1.jpg', position: 0 },
      // locked woman's photo URL is deliberately id-free so the non-leak assertions stay valid
      { user_id: 'w1', url: 'http://p/locked.jpg', position: 0 },
    ] })
    return chainable({ data: null })
  })
}

describe('GET /likes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: false })
    app = await buildApp()
  })

  async function get() {
    const res = await app.inject({ method: 'GET', url: '/likes', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('locks women likers and hides their identity for a non-premium viewer', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any)
    mockDb({ enabled: true, myPremiumUntil: null })
    const body = await get()
    expect(body.lockedCount).toBe(1)
    expect(body.premiumRequired).toBe(true)
    expect(body.visible.map((v: any) => v.id)).toEqual(['m1'])
    // visible liker carries profile fields for the liker-profile view
    expect(body.visible[0].location).toBe('Shiraz')
    expect(body.visible[0].interests).toEqual(['Hiking', 'Music'])
    // locked woman exposes ONLY her photo (for the blurred tile) — no identity
    expect(body.locked).toEqual([{ photo: 'http://p/locked.jpg' }])
    expect(JSON.stringify(body)).not.toContain('Sara') // name
    expect(JSON.stringify(body)).not.toContain('Yoga') // interest
    expect(JSON.stringify(body)).not.toContain('w1')   // id
    expect(body.visible[0].photos).toEqual(['http://p/m1.jpg'])
    expect(body.visible[0].premium).toBe(false)
  })

  it('shows everyone when the viewer is premium', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any)
    mockDb({ enabled: true, myPremiumUntil: new Date(Date.now() + 86400000).toISOString() })
    const body = await get()
    expect(body.lockedCount).toBe(0)
    expect(body.premiumRequired).toBe(false)
    expect(body.visible.map((v: any) => v.id).sort()).toEqual(['m1', 'w1'])
  })

  it('shows everyone when premium is globally disabled', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any)
    mockDb({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.lockedCount).toBe(0)
    expect(body.visible.length).toBe(2)
  })

  it('shows a woman only her revealed liker', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'm1' })
    vi.mocked(getIncomingLiker).mockResolvedValue(man as any)
    vi.mocked(getIncomingLikers).mockResolvedValue([
      man,
      { ...man, id: 'm2', name: 'Reza', telegramId: 4, likedAt: '2026-10-07T00:00:00.000Z' },
    ] as any)
    mockDb({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible.map((v: any) => v.id)).toEqual(['m1'])
    expect(JSON.stringify(body)).not.toContain('Reza')
    expect(body.lockedCount).toBe(0)
    expect(getIncomingLiker).toHaveBeenCalledWith('me', 'm1')
    expect(getIncomingLikers).not.toHaveBeenCalled()
  })

  it('shows the revealed liker even when he is outside the newest 100', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'old-man' })
    // The capped list is 100 newer likers and does not contain him.
    vi.mocked(getIncomingLikers).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({ ...man, id: `new-${i}`, likedAt: '2026-10-06T00:00:00.000Z' })) as any,
    )
    vi.mocked(getIncomingLiker).mockResolvedValue({ ...man, id: 'old-man', name: 'Old', likedAt: '2026-01-01T00:00:00.000Z' } as any)
    mockDb({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible.map((v: any) => v.id)).toEqual(['old-man'])
  })

  it('shows a woman nobody when the revealed liker no longer qualifies', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'm1' })
    vi.mocked(getIncomingLiker).mockResolvedValue(null)
    mockDb({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible).toEqual([])
  })

  it('shows a woman nobody after today\'s reveal is spent', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: null })
    vi.mocked(getIncomingLikers).mockResolvedValue([man] as any)
    mockDb({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible).toEqual([])
    expect(body.lockedCount).toBe(0)
  })
})

describe('GET /likes/unread-count', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: false })
    app = await buildApp()
  })

  async function count() {
    const res = await app.inject({ method: 'GET', url: '/likes/unread-count', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(200)
    return res.json().count
  }

  it('counts all likers when the watermark is null', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any)
    mockDb({ enabled: true, myPremiumUntil: null, seenAt: null })
    expect(await count()).toBe(2)
  })

  it('counts only likers newer than the watermark', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any) // 08-08 and 08-07
    mockDb({ enabled: true, myPremiumUntil: null, seenAt: '2026-08-07T12:00:00Z' })
    expect(await count()).toBe(1) // only the 08-08 like is newer
  })

  it('counts only the revealed like for a woman', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'm1' })
    vi.mocked(getIncomingLiker).mockResolvedValue(man as any)
    vi.mocked(getIncomingLikers).mockResolvedValue([woman, man] as any)
    mockDb({ enabled: true, myPremiumUntil: null, seenAt: null })
    expect(await count()).toBe(1)
  })

  it('counts zero when the revealed like is older than the watermark', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'm1' })
    vi.mocked(getIncomingLiker).mockResolvedValue(man as any) // likedAt 2026-08-07
    mockDb({ enabled: true, myPremiumUntil: null, seenAt: '2026-08-08T00:00:00.000Z' })
    expect(await count()).toBe(0)
  })

  it('counts the revealed liker outside the newest 100 against the watermark', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: 'old-man' })
    vi.mocked(getIncomingLikers).mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ ...man, id: `new-${i}`, likedAt: '2026-10-06T00:00:00.000Z' })) as any,
    )
    vi.mocked(getIncomingLiker).mockResolvedValue({ ...man, id: 'old-man', likedAt: '2026-09-01T00:00:00.000Z' } as any)
    mockDb({ enabled: false, myPremiumUntil: null, seenAt: '2026-08-01T00:00:00.000Z' })
    expect(await count()).toBe(1)
  })
})
