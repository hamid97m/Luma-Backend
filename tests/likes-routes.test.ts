import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// Liker lists and the reveal have their own suites (likes-service, reveal); here
// they are inputs, and the route's own reads (toggle, premium, photos, watermark)
// hit the real database.
vi.mock('../src/likes/service.js', () => ({ getIncomingLikers: vi.fn(), getIncomingLiker: vi.fn() }))
vi.mock('../src/likes/reveal.js', () => ({
  ensureDailyReveal: vi.fn().mockResolvedValue({ applies: false }),
  hiddenIncomingLikerIds: vi.fn().mockResolvedValue([]),
}))

import { buildApp } from '../src/server.js'
import { getIncomingLikers, getIncomingLiker } from '../src/likes/service.js'
import { ensureDailyReveal } from '../src/likes/reveal.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'

let me: Record<string, any>
let woman: Record<string, any>
let man: Record<string, any>

async function setup(opts: { enabled: boolean; myPremiumUntil: string | null; seenAt?: string | null }) {
  await sql`update premium_config set premium_enabled = ${opts.enabled}`
  await sql`update users set premium_until = ${opts.myPremiumUntil}, likes_seen_at = ${opts.seenAt ?? null} where id = ${me.id}`
}

/** IncomingLiker objects (what the service returns) for real users. */
const asLiker = (u: Record<string, any>, extra: Record<string, unknown>) => ({
  id: u.id, name: u.name, age: u.age, bio: u.bio, location: u.location, interests: u.interests,
  telegramId: u.telegram_id, gender: u.gender, premium: false, ...extra,
})

beforeEach(async () => {
  await resetDb()
  vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: false })
  me = await createUser({ name: 'Me' })
  woman = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', location: 'Tehran', interests: ['Yoga'] })
  man = await createUser({ name: 'Ali', gender: 'man', looking_for: 'women', bio: 'hi', location: 'Shiraz', interests: ['Hiking', 'Music'] })
  await createPhoto(man.id, 1, { url: 'http://p/m1-b.jpg' })
  await createPhoto(man.id, 0, { url: 'http://p/m1.jpg' })
  // Locked woman's photo URL is deliberately id-free so the non-leak assertions stay valid.
  await createPhoto(woman.id, 0, { url: 'http://p/locked.jpg' })
  authAs(me)
})

const W = () => asLiker(woman, { likedAt: '2026-08-08T00:00:00.000Z' })
const M = () => asLiker(man, { likedAt: '2026-08-07T00:00:00.000Z' })

describe('GET /likes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  async function get() {
    const res = await app.inject({ method: 'GET', url: '/likes', headers: AUTH })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('locks women likers and hides their identity for a non-premium viewer', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: true, myPremiumUntil: null })
    const body = await get()
    expect(body.lockedCount).toBe(1)
    expect(body.premiumRequired).toBe(true)
    expect(body.visible.map((v: any) => v.id)).toEqual([man.id])
    // visible liker carries profile fields for the liker-profile view
    expect(body.visible[0].location).toBe('Shiraz')
    expect(body.visible[0].interests).toEqual(['Hiking', 'Music'])
    // locked woman exposes ONLY her photo (for the blurred tile) — no identity
    expect(body.locked).toEqual([{ photo: 'http://p/locked.jpg' }])
    expect(JSON.stringify(body)).not.toContain('Sara') // name
    expect(JSON.stringify(body)).not.toContain('Yoga') // interest
    expect(JSON.stringify(body)).not.toContain(woman.id) // id
    // photos in position order
    expect(body.visible[0].photos).toEqual(['http://p/m1.jpg', 'http://p/m1-b.jpg'])
    expect(body.visible[0].premium).toBe(false)
  })

  it('shows everyone when the viewer is premium', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: true, myPremiumUntil: new Date(Date.now() + 86400000).toISOString() })
    const body = await get()
    expect(body.lockedCount).toBe(0)
    expect(body.premiumRequired).toBe(false)
    expect(body.visible.map((v: any) => v.id).sort()).toEqual([man.id, woman.id].sort())
  })

  it('locks again once the viewer\'s premium has expired', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: true, myPremiumUntil: new Date(Date.now() - 1000).toISOString() })
    expect((await get()).lockedCount).toBe(1)
  })

  it('shows everyone when premium is globally disabled', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.lockedCount).toBe(0)
    expect(body.visible.length).toBe(2)
  })

  it('marks the likes as seen', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([M()] as any)
    await setup({ enabled: false, myPremiumUntil: null, seenAt: null })
    await get()
    // fire-and-forget update: wait for it to land rather than sleeping
    const row = await vi.waitFor(async () => {
      const [r] = await sql`select likes_seen_at from users where id = ${me.id}`
      if (!r.likes_seen_at) throw new Error('likes_seen_at not written yet')
      return r
    })
    expect(Date.now() - new Date(row.likes_seen_at).getTime()).toBeLessThan(5_000)
  })

  it('shows a woman only her revealed liker', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    vi.mocked(getIncomingLiker).mockResolvedValue(M() as any)
    vi.mocked(getIncomingLikers).mockResolvedValue([
      M(),
      { ...M(), id: randomUUID(), name: 'Reza', telegramId: 4, likedAt: '2026-10-07T00:00:00.000Z' },
    ] as any)
    await setup({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible.map((v: any) => v.id)).toEqual([man.id])
    expect(JSON.stringify(body)).not.toContain('Reza')
    expect(body.lockedCount).toBe(0)
    expect(getIncomingLiker).toHaveBeenCalledWith(me.id, man.id)
    expect(getIncomingLikers).not.toHaveBeenCalled()
  })

  it('shows the revealed liker even when he is outside the newest 100', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    // The capped list is 100 newer likers and does not contain him.
    vi.mocked(getIncomingLikers).mockResolvedValue(
      Array.from({ length: 100 }, () => ({ ...M(), id: randomUUID(), likedAt: '2026-10-06T00:00:00.000Z' })) as any,
    )
    vi.mocked(getIncomingLiker).mockResolvedValue({ ...M(), name: 'Old', likedAt: '2026-01-01T00:00:00.000Z' } as any)
    await setup({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible.map((v: any) => v.id)).toEqual([man.id])
  })

  it('shows a woman nobody when the revealed liker no longer qualifies', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    vi.mocked(getIncomingLiker).mockResolvedValue(null)
    await setup({ enabled: false, myPremiumUntil: null })
    expect((await get()).visible).toEqual([])
  })

  it('shows a woman nobody after today\'s reveal is spent', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: null })
    vi.mocked(getIncomingLikers).mockResolvedValue([M()] as any)
    await setup({ enabled: false, myPremiumUntil: null })
    const body = await get()
    expect(body.visible).toEqual([])
    expect(body.lockedCount).toBe(0)
  })
})

describe('GET /likes/unread-count', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  async function count() {
    const res = await app.inject({ method: 'GET', url: '/likes/unread-count', headers: AUTH })
    expect(res.statusCode).toBe(200)
    return res.json().count
  }

  it('counts all likers when the watermark is null', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: true, myPremiumUntil: null, seenAt: null })
    expect(await count()).toBe(2)
  })

  it('counts only likers newer than the watermark', async () => {
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any) // 08-08 and 08-07
    await setup({ enabled: true, myPremiumUntil: null, seenAt: '2026-08-07T12:00:00Z' })
    expect(await count()).toBe(1) // only the 08-08 like is newer
  })

  it('counts only the revealed like for a woman', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    vi.mocked(getIncomingLiker).mockResolvedValue(M() as any)
    vi.mocked(getIncomingLikers).mockResolvedValue([W(), M()] as any)
    await setup({ enabled: true, myPremiumUntil: null, seenAt: null })
    expect(await count()).toBe(1)
  })

  it('counts zero when the revealed like is older than the watermark', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    vi.mocked(getIncomingLiker).mockResolvedValue(M() as any) // likedAt 2026-08-07
    await setup({ enabled: true, myPremiumUntil: null, seenAt: '2026-08-08T00:00:00.000Z' })
    expect(await count()).toBe(0)
  })

  it('counts the revealed liker outside the newest 100 against the watermark', async () => {
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: man.id })
    vi.mocked(getIncomingLikers).mockResolvedValue(
      Array.from({ length: 101 }, () => ({ ...M(), id: randomUUID(), likedAt: '2026-10-06T00:00:00.000Z' })) as any,
    )
    vi.mocked(getIncomingLiker).mockResolvedValue({ ...M(), likedAt: '2026-09-01T00:00:00.000Z' } as any)
    await setup({ enabled: false, myPremiumUntil: null, seenAt: '2026-08-01T00:00:00.000Z' })
    expect(await count()).toBe(1)
  })
})
