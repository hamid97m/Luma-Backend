import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const TG_USER = { id: 1, first_name: 'Ali' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue(TG_USER as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /profile/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns full profile with photos', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        select: () => ({
          eq: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null }, error: null }) }),
        }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({
          eq: () => ({ order: () => ({ data: [{ id: 'p1', url: 'https://img', position: 0 }], error: null }) }),
        }),
      } as any)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Ali',
      age: 25,
      photos: [{ id: 'p1', position: 0 }],
      setupComplete: true,
    })
  })
})

describe('PUT /profile/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('updates bio and returns updated profile', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: 'سلام' }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { bio: 'سلام' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().bio).toBe('سلام')
  })

  it('pauses the account by setting is_active to false', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null, is_active: false }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { is_active: false },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().is_active).toBe(false)
  })
})
