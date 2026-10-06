import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/swipeLimit.js', () => ({
  getSwipeLimitStatus: vi.fn().mockResolvedValue({ limited: false, resetAt: null }),
}))
vi.mock('../src/premium/directChatLimit.js', () => ({
  getDirectChatStatus: vi.fn().mockResolvedValue({ gate: 'free', remaining: 3, limit: 3, resetAt: null }),
}))
vi.mock('../src/likes/reveal.js', () => ({
  hiddenIncomingLikerIds: vi.fn().mockResolvedValue([]),
  ensureDailyReveal: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getSwipeLimitStatus } from '../src/premium/swipeLimit.js'
import { hiddenIncomingLikerIds } from '../src/likes/reveal.js'
import { chainable } from './admin-helpers.js'

const DIRECT_CHAT_DEFAULT = { gate: 'free', remaining: 3, limit: 3, resetAt: null }

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

// Seed top-up query runs whenever the real-user batch is under BATCH_SIZE (10),
// which is every case here — it's a fresh db.from('users') call, so it needs its
// own queued mock after the real-profile tier(s). Fake/seed users rank last.
function mockSeedTopUp(data: unknown[] = []) {
  vi.mocked(db.from).mockReturnValueOnce(chainable({ data, error: null }))
}

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /discovery', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    app = await buildApp()
    vi.mocked(hiddenIncomingLikerIds).mockResolvedValue([])
  })

  it('returns exhausted: true when no profiles remain', async () => {
    setupAuth()

    // viewer lookup — looking_for: women → genderFilter = 'woman'
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women' }, error: null }) }) }),
    } as any)
    // recent swipes
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks (both directions via .or())
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // profiles query — chainable tolerates the full is_active→banned→age→gender→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    // seed top-up — no seeds either
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null }, directChat: DIRECT_CHAT_DEFAULT })
  })

  it('returns profiles with photos sorted by position', async () => {
    setupAuth()

    // viewer lookup — looking_for: women
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women' }, error: null }) }) }),
    } as any)
    // recent swipes — one existing swipe to exclude
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [{ swiped_id: 'user-uuid-3' }], error: null }) }) }),
    } as any)
    // blocks — empty (both directions via .or())
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // profiles query — chainable tolerates the full is_active→banned→age→gender→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({
      data: [
        {
          id: 'user-uuid-2',
          name: 'Sara',
          age: 27,
          bio: 'سلام',
          telegram_id: 999,
          premium_until: '2099-01-01T00:00:00.000Z',
          user_photos: [
            { id: 'ph2', url: 'https://img2.jpg', position: 1 },
            { id: 'ph1', url: 'https://img1.jpg', position: 0 },
          ],
        },
      ],
      error: null,
    }))
    // seed top-up — one real profile (< 10) still triggers the query; no seeds
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.exhausted).toBe(false)
    expect(body.profiles).toHaveLength(1)
    expect(body.profiles[0]).toEqual({
      id: 'user-uuid-2',
      name: 'Sara',
      age: 27,
      bio: 'سلام',
      telegramId: 999,
      interests: [],
      location: null,
      nearby: false,
      premium: true,
      photos: ['https://img1.jpg', 'https://img2.jpg'],
    })
  })

  it('filters candidates to those whose looking_for includes the viewer gender', async () => {
    setupAuth()

    // viewer — a man who looks for everyone (no viewer-side gender filter)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'everyone', gender: 'man', location: null }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // rest-tier profile query — capture the chain calls
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }, log))
    // seed top-up — separate query, not part of the captured rest-tier log
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    // A man-viewer must only see candidates whose looking_for includes men.
    const inCall = log.find((c) => c.method === 'in' && c.args[0] === 'looking_for')
    expect(inCall).toBeDefined()
    expect(inCall!.args[1]).toEqual(['men', 'everyone', 'both'])
  })

  it('explicitly excludes soft-deleted users from every profile query', async () => {
    setupAuth()

    // viewer lookup
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women' }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // rest-tier profile query — capture the chain calls
    const restLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }, restLog))
    // seed top-up — capture too: seeds must also honor the deleted_at guard
    const seedLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }, seedLog))

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    // deleted_at must be guarded explicitly — not left to the is_active
    // coincidence (delete also flips is_active=false today).
    for (const log of [restLog, seedLog]) {
      const isCall = log.find((c) => c.method === 'is' && c.args[0] === 'deleted_at')
      expect(isCall).toBeDefined()
      expect(isCall!.args[1]).toBeNull()
    }
  })

  it('returns 401 when no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/discovery' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when viewer not found in users table', async () => {
    setupAuth()

    // viewer lookup → null (user not found)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: null, error: { message: 'not found' } }) }) }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('applies no gender filter when looking_for is both', async () => {
    setupAuth()

    // viewer lookup → looking_for: both — no genderFilter applied
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'both' }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty (both directions via .or())
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // profiles query — chainable tolerates the is_active→banned→age→(no gender)→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    // seed top-up — no seeds
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null }, directChat: DIRECT_CHAT_DEFAULT })
  })

  it('includes the liker, same-city, and rest profiles in the batch (order shuffled)', async () => {
    setupAuth()

    // viewer — resolved geo so the city and country tiers run
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', location: 'Tehran', geo_city: 'Tehran', geo_country: 'IR' }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — one person liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [{ swiper_id: 'liker-1' }], error: null }) }) }) }) }),
    } as any)
    const profile = (id: string, location: string) => ({
      id, name: 'N', age: 25, bio: null, telegram_id: 1,
      interests: [], location, user_photos: [],
    })
    // Each tier's profileQuery chain (now includes .gt('age', 0)) → chainable
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('liker-1', 'Tehran')], error: null }))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('city-1', 'Tehran')], error: null }))
    // same-country tier — nobody extra
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('rest-1', 'Mashhad')], error: null }))
    // seed top-up — 3 real profiles (< 10) still triggers it; no seeds so the
    // batch stays real-only. Seeds would otherwise land at the tail.
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // All three tiers land in the batch; order is shuffled so assert membership,
    // not position. No liker marker leaks into the payload.
    expect(body.profiles.map((p: any) => p.id).sort()).toEqual(['city-1', 'liker-1', 'rest-1'])
    expect(body.profiles[0]).not.toHaveProperty('likedYou')
  })

  it('shows same city, then country, then language, then rest — and never returns ranking fields', async () => {
    setupAuth()

    // viewer typed Persian, resolved to Tehran/IR, app language fa
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', location: 'تهران', geo_city: 'Tehran', geo_country: 'IR', locale: 'fa' }, error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    const profile = (id: string, location: string, geo_city: string | null, geo_country: string | null, locale = 'en') => ({
      id, name: 'N', age: 25, bio: null, telegram_id: 1, interests: [], location, geo_city, geo_country, locale, user_photos: [],
    })
    const cityLog: Array<{ method: string; args: unknown[] }> = []
    const countryLog: Array<{ method: string; args: unknown[] }> = []
    const languageLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('city-1', 'tehran', 'Tehran', 'IR')], error: null }, cityLog))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('country-1', 'Mashhad', 'Mashhad', 'IR')], error: null }, countryLog))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('lang-1', 'Dubai', 'Dubai', 'AE', 'fa')], error: null }, languageLog))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('rest-1', 'Berlin', 'Berlin', 'DE')], error: null }))
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    // city tier matches the normalized city, not the typed text
    expect(cityLog).toContainEqual({ method: 'eq', args: ['geo_country', 'IR'] })
    expect(cityLog).toContainEqual({ method: 'eq', args: ['geo_city', 'Tehran'] })
    expect(cityLog.find((c) => c.method === 'ilike')).toBeUndefined()
    // country tier excludes the city-tier pick
    expect(countryLog).toContainEqual({ method: 'eq', args: ['geo_country', 'IR'] })
    expect(countryLog).toContainEqual({ method: 'not', args: ['id', 'in', `(${USER_ID},city-1)`] })

    // language tier matches the viewer's app language and excludes earlier picks
    expect(languageLog).toContainEqual({ method: 'eq', args: ['locale', 'fa'] })
    expect(languageLog).toContainEqual({ method: 'not', args: ['id', 'in', `(${USER_ID},city-1,country-1)`] })

    // display order is closest-first
    expect(res.json().profiles.map((p: any) => p.id)).toEqual(['city-1', 'country-1', 'lang-1', 'rest-1'])

    const byId = Object.fromEntries(res.json().profiles.map((p: any) => [p.id, p]))
    // "تهران" vs "tehran" is the same city once normalized
    expect(byId['city-1'].nearby).toBe(true)
    expect(byId['country-1'].nearby).toBe(false)
    for (const p of res.json().profiles) {
      expect(p).not.toHaveProperty('geo_city')
      expect(p).not.toHaveProperty('geo_country')
      expect(p).not.toHaveProperty('locale')
    }
  })

  it('ignores the typed city when the viewer has no resolved geo', async () => {
    setupAuth()

    // viewer typed a city but it is not resolved → no city/country tier, no text matching
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', location: 'Tehran', geo_city: null, geo_country: null }, error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    const restLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({
      data: [{ id: 'rest-1', name: 'N', age: 25, bio: null, telegram_id: 1, interests: [], location: 'Tehran', geo_city: null, geo_country: null, user_photos: [] }],
      error: null,
    }, restLog))
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    // auth + viewer + swipes + blocks + likerSwipes + rest + seed — no city tier
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(7)
    expect(restLog.find((c) => c.method === 'ilike')).toBeUndefined()
    // same typed text, but unresolved → not "nearby"
    expect(res.json().profiles[0].nearby).toBe(false)
  })

  it('appends seed/fake profiles at the tail when real users run low', async () => {
    setupAuth()

    // viewer — no location so only the rest tier runs for real users
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', location: null }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    const profile = (id: string) => ({
      id, name: 'N', age: 25, bio: null, telegram_id: 1, interests: [], location: null, user_photos: [],
    })
    // rest tier — one real user
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('real-1')], error: null }))
    // seed top-up — one seed user fills the tail
    mockSeedTopUp([profile('seed-1')])

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Real user first, seed appended at the tail (never shuffled among reals).
    expect(body.profiles.map((p: any) => p.id)).toEqual(['real-1', 'seed-1'])
  })

  it('excludes already-swiped likers and skips the city tier without a location', async () => {
    setupAuth()

    // viewer — no location → city tier must be skipped
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'both', location: null }, error: null }) }) }),
    } as any)
    // recent swipes — viewer already liked 'liker-1' (they are matched or pending)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [{ swiped_id: 'liker-1' }], error: null }) }) }),
    } as any)
    // blocks — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — only the excluded liker → liker-profiles query must NOT run
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [{ swiper_id: 'liker-1' }], error: null }) }) }) }) }),
    } as any)
    // rest profiles (no gender filter) — chainable tolerates the is_active→banned→age→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    // seed top-up — no seeds
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null }, directChat: DIRECT_CHAT_DEFAULT })
    // auth + viewer + swipes + blocks + likerSwipes + rest + seed = exactly 7 db calls
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(7)
  })

  it('includes swipeLimit status in the response', async () => {
    setupAuth()

    // viewer lookup — looking_for: women → genderFilter = 'woman'
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women' }, error: null }) }) }),
    } as any)
    // recent swipes
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks (both directions via .or())
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [], error: null }) }) }) }) }),
    } as any)
    // profiles query — chainable tolerates the full is_active→banned→age→gender→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    // seed top-up — no seeds
    mockSeedTopUp()

    vi.mocked(getSwipeLimitStatus).mockResolvedValueOnce({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json().swipeLimit).toEqual({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })
  })

  it('drops queued likers from a woman\'s deck and keeps the revealed one', async () => {
    setupAuth()
    vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(['hidden-man'])
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'men', gender: 'woman', geo_city: null, geo_country: null, locale: null }, error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [
        { swiper_id: 'revealed-man' },
        { swiper_id: 'hidden-man' },
      ], error: null }) }) }) }) }),
    } as any)
    const likerLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({
      data: [{
        id: 'revealed-man', name: 'Ali', age: 30, bio: null, telegram_id: 3,
        interests: [], location: null, premium_until: null,
        user_photos: [{ id: 'p1', url: 'http://p/a.jpg', position: 0 }],
      }],
      error: null,
    }, likerLog))
    // No city, country, or locale on the viewer, so the only remaining real-profile
    // query is the final "everyone else" tier. Then the seed top-up.
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
    mockSeedTopUp()

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const ids = res.json().profiles.map((p: { id: string }) => p.id)
    expect(ids).toContain('revealed-man')
    expect(ids).not.toContain('hidden-man')
    const inCall = likerLog.find((c) => c.method === 'in' && c.args[0] === 'id')
    expect(inCall?.args[1]).toEqual(['revealed-man'])
  })

  describe('hidden likers never leak', () => {
    const profile = (id: string) => ({
      id, name: id, age: 30, bio: null, telegram_id: 3,
      interests: [], location: null, premium_until: null,
      user_photos: [{ id: `p-${id}`, url: `http://p/${id}.jpg`, position: 0 }],
    })

    // Viewer has no city/country/locale → the only real-profile query after tier 1
    // is the "everyone else" tier, then the seed top-up.
    function setupWoman(likerIds: string[], tierData: unknown[], opts: { likerQueryData?: unknown[] } = {}) {
      setupAuth()
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'men', gender: 'woman', geo_city: null, geo_country: null, locale: null }, error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ or: () => ({ data: [], error: null }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: likerIds.map((id) => ({ swiper_id: id })), error: null }) }) }) }) }),
      } as any)
      const likerLog: Array<{ method: string; args: unknown[] }> = []
      if (opts.likerQueryData) {
        vi.mocked(db.from).mockReturnValueOnce(chainable({ data: opts.likerQueryData, error: null }, likerLog))
      }
      const tierLog: Array<{ method: string; args: unknown[] }> = []
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: tierData, error: null }, tierLog))
      const seedLog: Array<{ method: string; args: unknown[] }> = []
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }, seedLog))
      return { likerLog, tierLog, seedLog }
    }

    it('drops a hidden liker returned by a later-tier query', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(['hidden-man'])
      setupWoman(['hidden-man'], [profile('hidden-man'), profile('stranger')])
      const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().profiles.map((p: { id: string }) => p.id)).toEqual(['stranger'])
    })

    it('does not interpolate more than 50 hidden ids into .not(id, in, …) and still drops them', async () => {
      const hidden = Array.from({ length: 60 }, (_, i) => `hidden-${i}`)
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(hidden)
      const { tierLog, seedLog } = setupWoman(hidden, [profile('hidden-3'), profile('stranger')])
      const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().profiles.map((p: { id: string }) => p.id)).toEqual(['stranger'])
      for (const log of [tierLog, seedLog]) {
        const notCall = log.find((c) => c.method === 'not' && c.args[0] === 'id')
        expect(notCall).toBeDefined()
        expect(String(notCall!.args[2])).not.toContain('hidden-')
      }
    })

    it('interpolates a short hidden list into .not(id, in, …)', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(['hidden-man'])
      const { tierLog } = setupWoman(['hidden-man'], [profile('stranger')])
      await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      const notCall = tierLog.find((c) => c.method === 'not' && c.args[0] === 'id')
      expect(String(notCall!.args[2])).toContain('hidden-man')
    })

    it('pages past more than 50 hidden likers so a later tier still returns a non-liker', async () => {
      const FILLER_POOL = 20
      const hidden = Array.from({ length: 60 }, (_, i) => `hidden-${i}`)
      vi.mocked(hiddenIncomingLikerIds).mockResolvedValue(hidden)
      // Page 1 is a full FILLER_POOL of hidden men; the non-liker sits behind them on page 2.
      const page1 = hidden.slice(0, FILLER_POOL).map(profile)
      const page2 = [profile('stranger')]
      setupAuth()
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'men', gender: 'woman', geo_city: null, geo_country: null, locale: null }, error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ or: () => ({ data: [], error: null }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: hidden.map((id) => ({ swiper_id: id })), error: null }) }) }) }) }),
      } as any)
      const rangeLog: Array<{ method: string; args: unknown[] }> = []
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: page1, error: null }, rangeLog))
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: page2, error: null }, rangeLog))
      mockSeedTopUp()
      const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().profiles.map((p: { id: string }) => p.id)).toEqual(['stranger'])
      expect(rangeLog.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([[0, FILLER_POOL - 1], [FILLER_POOL, 2 * FILLER_POOL - 1]])
    })

    it('keeps a man\'s likers visible when the reveal read throws', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupAuth()
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', gender: 'man', geo_city: null, geo_country: null, locale: null }, error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ or: () => ({ data: [], error: null }) }),
      } as any)
      vi.mocked(db.from).mockReturnValueOnce({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: () => ({ data: [{ swiper_id: 'f1' }], error: null }) }) }) }) }),
      } as any)
      const likerLog: Array<{ method: string; args: unknown[] }> = []
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('f1')], error: null }, likerLog))
      vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
      mockSeedTopUp()
      const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().profiles.map((p: { id: string }) => p.id)).toEqual(['f1'])
      expect(likerLog.find((c) => c.method === 'in' && c.args[0] === 'id')?.args[1]).toEqual(['f1'])
      errSpy.mockRestore()
    })

    it('hides every liker, without a 500, when the reveal read throws', async () => {
      vi.mocked(hiddenIncomingLikerIds).mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { likerLog, tierLog } = setupWoman(['m1', 'm2'], [profile('m1'), profile('stranger')])
      const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().profiles.map((p: { id: string }) => p.id)).toEqual(['stranger'])
      // tier 1 gets nobody, so no liker-profile query ran (the queued tier mock served tier 5)
      expect(likerLog).toEqual([])
      expect(String(tierLog.find((c) => c.method === 'not')!.args[2])).toContain('m1')
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })
})
