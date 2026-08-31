import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/swipeLimit.js', () => ({
  getSwipeLimitStatus: vi.fn().mockResolvedValue({ limited: false, resetAt: null }),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getSwipeLimitStatus } from '../src/premium/swipeLimit.js'
import { chainable } from './admin-helpers.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /discovery', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

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
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
    } as any)
    // profiles query — chainable tolerates the full is_active→banned→age→gender→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null } })
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
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
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
          user_photos: [
            { id: 'ph2', url: 'https://img2.jpg', position: 1 },
            { id: 'ph1', url: 'https://img1.jpg', position: 0 },
          ],
        },
      ],
      error: null,
    }))

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
      photos: ['https://img1.jpg', 'https://img2.jpg'],
    })
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
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
    } as any)
    // profiles query — chainable tolerates the is_active→banned→age→(no gender)→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null } })
  })

  it('includes the liker, same-city, and rest profiles in the batch (order shuffled)', async () => {
    setupAuth()

    // viewer — has a location so the city tier runs
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', location: 'Tehran' }, error: null }) }) }),
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
      select: () => ({ eq: () => ({ eq: () => ({ data: [{ swiper_id: 'liker-1' }], error: null }) }) }),
    } as any)
    const profile = (id: string, location: string) => ({
      id, name: 'N', age: 25, bio: null, telegram_id: 1,
      interests: [], location, user_photos: [],
    })
    // Each tier's profileQuery chain (now includes .gt('age', 0)) → chainable
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('liker-1', 'Tehran')], error: null }))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('city-1', 'Tehran')], error: null }))
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [profile('rest-1', 'Mashhad')], error: null }))

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // All three tiers land in the batch; order is shuffled so assert membership,
    // not position. No liker marker leaks into the payload.
    expect(body.profiles.map((p: any) => p.id).sort()).toEqual(['city-1', 'liker-1', 'rest-1'])
    expect(body.profiles[0]).not.toHaveProperty('likedYou')
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
      select: () => ({ eq: () => ({ eq: () => ({ data: [{ swiper_id: 'liker-1' }], error: null }) }) }),
    } as any)
    // rest profiles (no gender filter) — chainable tolerates the is_active→banned→age→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true, swipeLimit: { limited: false, resetAt: null } })
    // auth + viewer + swipes + blocks + likerSwipes + rest = exactly 6 db calls
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(6)
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
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
    } as any)
    // profiles query — chainable tolerates the full is_active→banned→age→gender→… chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))

    vi.mocked(getSwipeLimitStatus).mockResolvedValueOnce({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json().swipeLimit).toEqual({ limited: true, resetAt: '2026-08-07T16:00:00.000Z' })
  })
})
