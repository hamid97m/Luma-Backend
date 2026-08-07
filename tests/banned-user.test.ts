import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

describe('banned user enforcement', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('rejects a banned user with account_banned', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          single: () => ({
            data: { id: 'u1', deleted_at: null, banned_at: '2026-08-04T00:00:00Z', last_active: null },
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'GET', url: '/matches',
      headers: { authorization: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_banned', botUsername: null })
  })

  it('rejects a banned user on POST /auth/verify with account_banned', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: {
              id: 'u1', name: 'Ali', age: 25, gender: 'man', looking_for: 'women',
              bio: null, deleted_at: null, banned_at: '2026-08-04T00:00:00Z',
            },
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_banned', botUsername: null })
  })
})
