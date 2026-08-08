import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/likes/service.js', () => ({ getIncomingLikers: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getIncomingLikers } from '../src/likes/service.js'
import { chainable } from './admin-helpers.js'

const woman = { id: 'w1', name: 'Sara', age: 27, bio: null, location: 'Tehran', interests: ['Yoga'], telegramId: 2, gender: 'woman', likedAt: '2026-08-08T00:00:00Z' }
const man = { id: 'm1', name: 'Ali', age: 30, bio: 'hi', location: 'Shiraz', interests: ['Hiking', 'Music'], telegramId: 3, gender: 'man', likedAt: '2026-08-07T00:00:00Z' }

function mockDb(opts: { enabled: boolean; myPremiumUntil: string | null; seenAt?: string | null }) {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Me' } as any)
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return chainable({ data: { id: 'me', premium_until: opts.myPremiumUntil, likes_seen_at: opts.seenAt ?? null } })
    if (table === 'premium_config') return chainable({ data: { premium_enabled: opts.enabled } })
    if (table === 'user_photos') return chainable({ data: [{ user_id: 'm1', url: 'http://p/m1.jpg', position: 0 }] })
    return chainable({ data: null })
  })
}

describe('GET /likes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

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
    // no woman identity leaked anywhere in the payload
    expect(JSON.stringify(body)).not.toContain('Sara')
    expect(JSON.stringify(body)).not.toContain('Yoga')
    expect(JSON.stringify(body)).not.toContain('w1')
    expect(body.visible[0].photos).toEqual(['http://p/m1.jpg'])
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
})

describe('GET /likes/unread-count', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

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
})
