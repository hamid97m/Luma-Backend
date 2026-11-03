import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/premium/swipeLimit.js', () => ({
  getSwipeLimitStatus: vi.fn().mockResolvedValue({ limited: false, resetAt: null }),
}))
// Another area's module — its own tests cover it.
vi.mock('../src/premium/directChatLimit.js', () => ({
  getDirectChatStatus: vi.fn().mockResolvedValue({ gate: 'free', remaining: 3, limit: 3, resetAt: null }),
}))
// The reveal itself is covered by reveal.test.ts; here only its output matters.
vi.mock('../src/likes/reveal.js', () => ({
  hiddenIncomingLikerIds: vi.fn().mockResolvedValue([]),
  ensureDailyReveal: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { getSwipeLimitStatus } from '../src/premium/swipeLimit.js'
import { hiddenIncomingLikerIds } from '../src/likes/reveal.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { createProfile, like, pass, block, minutesAgo } from './helpers/discovery.js'

const DIRECT_CHAT_DEFAULT = { gate: 'free', remaining: 3, limit: 3, resetAt: null }

describe('GET /discovery', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    vi.mocked(hiddenIncomingLikerIds).mockResolvedValue([])
    vi.mocked(getSwipeLimitStatus).mockResolvedValue({ limited: false, resetAt: null })
  })

  /** A viewer (default: a man seeking women, no geo, no locale) authenticated for the next request. */
  async function viewerAs(overrides: Record<string, unknown> = {}) {
    const v = await createUser({ name: 'Viewer', gender: 'man', looking_for: 'women', ...overrides })
    authAs(v)
    return v
  }

  async function discover() {
    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(200)
    return res.json() as { profiles: any[]; exhausted: boolean; swipeLimit: unknown; directChat: unknown }
  }
  const ids = (body: { profiles: Array<{ id: string }> }) => body.profiles.map((p) => p.id)
  const names = (body: { profiles: Array<{ name: string }> }) => body.profiles.map((p) => p.name).sort()

  it('returns exhausted: true when no profiles remain', async () => {
    await viewerAs()
    expect(await discover()).toEqual({
      profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null }, directChat: DIRECT_CHAT_DEFAULT,
    })
  })

  it('returns profiles with photos sorted by position', async () => {
    await viewerAs()
    const sara = await createUser({
      name: 'Sara', age: 27, bio: 'سلام', gender: 'woman', looking_for: 'men', premium_until: '2099-01-01T00:00:00.000Z',
    })
    // Inserted out of order: the response must sort by position.
    await createPhoto(sara.id, 1, { url: 'https://img2.jpg' })
    await createPhoto(sara.id, 0, { url: 'https://img1.jpg' })

    const body = await discover()
    expect(body.exhausted).toBe(false)
    expect(body.profiles).toEqual([{
      id: sara.id,
      name: 'Sara',
      age: 27,
      bio: 'سلام',
      interests: [],
      location: null,
      nearby: false,
      premium: true,
      photos: ['https://img1.jpg', 'https://img2.jpg'],
    }])
  })

  it('filters candidates to those whose looking_for includes the viewer gender', async () => {
    // A man who looks for everyone: no viewer-side gender filter.
    await viewerAs({ looking_for: 'everyone' })
    await createProfile({ name: 'w-seeks-men', gender: 'woman', looking_for: 'men' })
    await createProfile({ name: 'w-seeks-women', gender: 'woman', looking_for: 'women' })
    await createProfile({ name: 'm-seeks-women', gender: 'man', looking_for: 'women' })
    await createProfile({ name: 'm-seeks-everyone', gender: 'man', looking_for: 'everyone' })
    await createProfile({ name: 'nb-seeks-both', gender: 'nonbinary', looking_for: 'both' })

    expect(names(await discover())).toEqual(['m-seeks-everyone', 'nb-seeks-both', 'w-seeks-men'])
  })

  it('applies no reciprocal filter for a nonbinary viewer', async () => {
    await viewerAs({ gender: 'nonbinary', looking_for: 'women' })
    await createProfile({ name: 'w-seeks-men', looking_for: 'men' })
    await createProfile({ name: 'w-seeks-women', looking_for: 'women' })
    expect(names(await discover())).toEqual(['w-seeks-men', 'w-seeks-women'])
  })

  it('excludes deleted, banned, paused, inactive, unfinished, ageless and photo-less users — real and seed', async () => {
    await viewerAs()
    for (const is_seed of [false, true]) {
      await createProfile({ is_seed, name: `deleted-${is_seed}`, deleted_at: minutesAgo(5) })
      await createProfile({ is_seed, name: `banned-${is_seed}`, banned_at: minutesAgo(5) })
      await createProfile({ is_seed, name: `paused-${is_seed}`, paused_at: minutesAgo(5) })
      await createProfile({ is_seed, name: `inactive-${is_seed}`, is_active: false })
      await createProfile({ is_seed, name: `preparing-${is_seed}`, account_status: 'preparing' })
      await createProfile({ is_seed, name: `age0-${is_seed}`, age: 0 })
      await createProfile({ is_seed, name: `nophoto-${is_seed}` }, 0)
      await createProfile({ is_seed, name: `ok-${is_seed}` })
    }
    // Soft-deleted but still flagged active — the deleted_at guard must hold on its own.
    expect(names(await discover())).toEqual(['ok-false', 'ok-true'])
  })

  it('returns 401 when no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/discovery' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when the viewer row is gone by the time discovery reads it', async () => {
    const v = await viewerAs()
    // Runs after the auth preHandler: the account disappears mid-request.
    app.addHook('preHandler', async () => {
      await sql`delete from users where id = ${v.id}`
    })
    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('applies no gender filter when looking_for is both', async () => {
    await viewerAs({ looking_for: 'both' })
    await createProfile({ name: 'woman', gender: 'woman', looking_for: 'men' })
    await createProfile({ name: 'man', gender: 'man', looking_for: 'men' })
    expect(names(await discover())).toEqual(['man', 'woman'])
  })

  it('includes the liker, same-city, and rest profiles in the batch (order shuffled)', async () => {
    const v = await viewerAs({ location: 'Tehran', geo_city: 'Tehran', geo_country: 'IR' })
    const liker = await createProfile({ name: 'liker-1', location: 'Tehran' })
    await like(liker, v)
    await createProfile({ name: 'city-1', location: 'Tehran', geo_city: 'Tehran', geo_country: 'IR' })
    await createProfile({ name: 'rest-1', location: 'Mashhad' })

    const body = await discover()
    expect(names(body)).toEqual(['city-1', 'liker-1', 'rest-1'])
    // No liker marker leaks into the payload.
    for (const p of body.profiles) expect(p).not.toHaveProperty('likedYou')
  })

  it('shows same city, then country, then language, then rest — and never returns ranking fields', async () => {
    // Viewer typed Persian, resolved to Tehran/IR, app language fa.
    await viewerAs({ location: 'تهران', geo_city: 'Tehran', geo_country: 'IR', locale: 'fa' })
    await createProfile({ name: 'rest-1', location: 'Berlin', geo_city: 'Berlin', geo_country: 'DE', locale: 'en' })
    await createProfile({ name: 'lang-1', location: 'Dubai', geo_city: 'Dubai', geo_country: 'AE', locale: 'fa' })
    await createProfile({ name: 'country-1', location: 'Mashhad', geo_city: 'Mashhad', geo_country: 'IR', locale: 'en' })
    await createProfile({ name: 'city-1', location: 'tehran', geo_city: 'Tehran', geo_country: 'IR', locale: 'en' })

    for (let i = 0; i < 5; i++) {
      const body = await discover()
      // Display order is closest-first.
      expect(body.profiles.map((p) => p.name)).toEqual(['city-1', 'country-1', 'lang-1', 'rest-1'])
      const byName = Object.fromEntries(body.profiles.map((p) => [p.name, p]))
      // "تهران" vs "tehran" is the same city once normalized.
      expect(byName['city-1'].nearby).toBe(true)
      expect(byName['country-1'].nearby).toBe(false)
      for (const p of body.profiles) {
        expect(p).not.toHaveProperty('geo_city')
        expect(p).not.toHaveProperty('geo_country')
        expect(p).not.toHaveProperty('locale')
      }
    }
  })

  it('does not treat the same city name in another country as nearby', async () => {
    await viewerAs({ geo_city: 'Paris', geo_country: 'FR' })
    await createProfile({ name: 'paris-us', geo_city: 'Paris', geo_country: 'US' })
    const body = await discover()
    expect(body.profiles[0].nearby).toBe(false)
  })

  it('ignores the typed city when the viewer has no resolved geo', async () => {
    await viewerAs({ location: 'Tehran', geo_city: null, geo_country: null })
    await createProfile({ name: 'rest-1', location: 'Tehran', geo_city: null, geo_country: null })
    const body = await discover()
    expect(names(body)).toEqual(['rest-1'])
    // Same typed text, but unresolved → not "nearby".
    expect(body.profiles[0].nearby).toBe(false)
  })

  it('appends seed/fake profiles at the tail when real users run low', async () => {
    await viewerAs()
    // The seed is more recently active, yet still lands after the real user.
    await createProfile({ name: 'seed-1', is_seed: true, last_active: minutesAgo(1) })
    await createProfile({ name: 'real-1', last_active: minutesAgo(600) })
    for (let i = 0; i < 5; i++) {
      expect((await discover()).profiles.map((p) => p.name)).toEqual(['real-1', 'seed-1'])
    }
  })

  it('tops up only the free slots with the most recently active seeds', async () => {
    await viewerAs()
    for (let i = 0; i < 8; i++) await createProfile({ name: `real-${i}` })
    await createProfile({ name: 'seed-new', is_seed: true, last_active: minutesAgo(1) })
    await createProfile({ name: 'seed-mid', is_seed: true, last_active: minutesAgo(10) })
    await createProfile({ name: 'seed-old', is_seed: true, last_active: minutesAgo(100) })

    const body = await discover()
    expect(body.profiles).toHaveLength(10)
    expect(body.profiles.slice(0, 8).every((p) => p.name.startsWith('real-'))).toBe(true)
    expect(body.profiles.slice(8).map((p) => p.name).sort()).toEqual(['seed-mid', 'seed-new'])
  })

  it('shows no seeds when real users fill the batch', async () => {
    await viewerAs()
    for (let i = 0; i < 12; i++) await createProfile({ name: `real-${i}` })
    await createProfile({ name: 'seed', is_seed: true })
    const body = await discover()
    expect(body.profiles).toHaveLength(10)
    expect(body.profiles.map((p) => p.name)).not.toContain('seed')
  })

  it('fills the deck with seeds only in the viewer language', async () => {
    const seedsFor = async (locale: string | null) => {
      await resetDb()
      await viewerAs({ locale })
      for (const l of [null, 'fa', 'en', 'ar']) await createProfile({ name: `seed-${l}`, is_seed: true, locale: l })
      return names(await discover())
    }
    // Unset locale is Persian, same as an explicit fa viewer. Current fakes have
    // no locale, so they match this filter and not en/ar.
    expect(await seedsFor(null)).toEqual(['seed-fa', 'seed-null'])
    expect(await seedsFor('fa')).toEqual(['seed-fa', 'seed-null'])
    expect(await seedsFor('en')).toEqual(['seed-en'])
    expect(await seedsFor('ar')).toEqual(['seed-ar'])
  })

  it('excludes already-swiped likers and skips the city tier without a location', async () => {
    const v = await viewerAs({ looking_for: 'both', location: null })
    // Viewer already liked liker-1 (they are matched or pending).
    const liker = await createProfile({ name: 'liker-1' })
    await like(liker, v)
    await like(v, liker)
    expect(await discover()).toEqual({
      profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null }, directChat: DIRECT_CHAT_DEFAULT,
    })
  })

  it('recycles passes older than 9 days but keeps recent passes and all likes out', async () => {
    const v = await viewerAs()
    const old = await createProfile({ name: 'old-pass' })
    const recent = await createProfile({ name: 'recent-pass' })
    const liked = await createProfile({ name: 'liked-long-ago' })
    await pass(v, old, { created_at: new Date(Date.now() - 10 * 24 * 3600_000).toISOString() })
    await pass(v, recent, { created_at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() })
    await like(v, liked, { created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() })
    expect(names(await discover())).toEqual(['old-pass'])
  })

  it('excludes blocks in both directions (and someone else\'s swipes do not matter)', async () => {
    const v = await viewerAs()
    const blockedByMe = await createProfile({ name: 'blocked-by-me' })
    const blockedMe = await createProfile({ name: 'blocked-me' })
    const free = await createProfile({ name: 'free' })
    await block(v, blockedByMe)
    await block(blockedMe, v)
    const other = await createUser()
    await pass(other, free)
    await block(other, free)
    expect(names(await discover())).toEqual(['free'])
  })

  it('boosts a liker into the batch even when 15 more recently active people compete', async () => {
    const v = await viewerAs()
    for (let i = 0; i < 15; i++) await createProfile({ name: `fresh-${i}`, last_active: minutesAgo(1) })
    const liker = await createProfile({ name: 'stale-liker', last_active: minutesAgo(10_000) })
    await like(liker, v)
    for (let i = 0; i < 3; i++) {
      const body = await discover()
      expect(body.profiles).toHaveLength(10)
      expect(body.profiles.map((p) => p.name)).toContain('stale-liker')
    }
  })

  it('caps liker slots at 4 but lets unpicked likers fall through to filler tiers', async () => {
    const v = await viewerAs()
    for (let i = 0; i < 6; i++) await like(await createProfile({ name: `liker-${i}` }), v)
    const body = await discover()
    expect(names(body)).toEqual(['liker-0', 'liker-1', 'liker-2', 'liker-3', 'liker-4', 'liker-5'])
  })

  it('never returns more than one batch, and never a duplicate', async () => {
    const v = await viewerAs({ geo_city: 'Tehran', geo_country: 'IR', locale: 'fa' })
    for (let i = 0; i < 25; i++) {
      const p = await createProfile({ name: `p-${i}`, geo_city: 'Tehran', geo_country: 'IR', locale: 'fa' })
      if (i < 3) await like(p, v)
    }
    const body = await discover()
    expect(body.profiles).toHaveLength(10)
    expect(new Set(ids(body)).size).toBe(10)
  })

  it('includes swipeLimit status in the response', async () => {
    await viewerAs()
    vi.mocked(getSwipeLimitStatus).mockResolvedValueOnce({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })
    expect((await discover()).swipeLimit).toEqual({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })
  })

  it('drops queued likers from a woman\'s deck and keeps the revealed one', async () => {
    const v = await viewerAs({ gender: 'woman', looking_for: 'men' })
    const revealed = await createProfile({ name: 'revealed-man', gender: 'man', looking_for: 'women' })
    const hidden = await createProfile({ name: 'hidden-man', gender: 'man', looking_for: 'women' })
    await like(revealed, v)
    await like(hidden, v)
    vi.mocked(hiddenIncomingLikerIds).mockResolvedValue([hidden.id])

    const body = await discover()
    expect(names(body)).toEqual(['revealed-man'])
    expect(hiddenIncomingLikerIds).toHaveBeenCalledWith(v.id)
  })

  describe('hidden likers never leak', () => {
    async function woman() {
      return viewerAs({ gender: 'woman', looking_for: 'men' })
    }
    const man = (name: string, extra: Record<string, unknown> = {}) =>
      createProfile({ name, gender: 'man', looking_for: 'women', ...extra })

    it('drops a hidden liker from every tier, including seeds', async () => {
      const v = await woman()
      const hiddenReal = await man('hidden-man')
      const hiddenSeed = await man('hidden-seed', { is_seed: true, locale: 'fa' })
      await like(hiddenReal, v)
      await like(hiddenSeed, v)
      await man('stranger')
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue([hiddenReal.id, hiddenSeed.id])
      expect(names(await discover())).toEqual(['stranger'])
    })

    it('drops more than 50 hidden likers, even when they are all more recently active', async () => {
      const v = await woman()
      const hidden: string[] = []
      for (let i = 0; i < 60; i++) {
        const m = await man(`hidden-${i}`, { last_active: minutesAgo(1) })
        await like(m, v)
        hidden.push(m.id)
      }
      // The only visible man sits behind 60 more recently active hidden ones.
      await man('stranger', { last_active: minutesAgo(10_000) })
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(hidden)
      expect(names(await discover())).toEqual(['stranger'])
    })

    it('keeps a man\'s likers visible when the reveal read throws', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const v = await viewerAs({ gender: 'man', looking_for: 'women' })
      await like(await createProfile({ name: 'f1' }), v)
      expect(names(await discover())).toEqual(['f1'])
      errSpy.mockRestore()
    })

    it('hides every liker, without a 500, when the reveal read throws', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const v = await woman()
      await like(await man('m1'), v)
      await like(await man('m2'), v)
      await man('stranger')
      expect(names(await discover())).toEqual(['stranger'])
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })
})
