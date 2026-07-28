import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

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
    // profiles query: eq(is_active) → eq(gender) → not(id) → order → limit
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          eq: () => ({
            not: () => ({
              order: () => ({
                limit: () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true })
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
    // profiles query: eq(is_active) → eq(gender) → not(id) → order → limit
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          eq: () => ({
            not: () => ({
              order: () => ({
                limit: () => ({
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
                }),
              }),
            }),
          }),
        }),
      }),
    } as any)

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
    // profiles query: eq(is_active) → not(id) → order → limit  (NO gender eq)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          not: () => ({
            order: () => ({
              limit: () => ({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profiles: [], exhausted: true })
  })
})
