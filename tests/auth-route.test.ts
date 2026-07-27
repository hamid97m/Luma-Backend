import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  verifyInitData: vi.fn(),
}))
vi.mock('../src/db.js', () => ({
  db: { from: vi.fn() },
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

describe('POST /auth/verify', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    app = await buildApp()
  })

  it('returns 401 for invalid initData', async () => {
    vi.mocked(verifyInitData).mockReturnValue(null)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'bad' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_init_data' })
  })

  it('creates a new user and returns setupComplete: false', async () => {
    vi.mocked(verifyInitData).mockReturnValue({
      id: 42,
      first_name: 'Hamid',
      username: 'hamid',
    })

    const mockFrom = vi.mocked(db.from)
    // First call: select existing user → not found
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }),
    } as any)
    // Second call: insert new user
    mockFrom.mockReturnValueOnce({
      insert: () => ({
        select: () => ({ single: () => ({ data: { id: 'uuid-1', name: 'Hamid' }, error: null }) }),
      }),
    } as any)
    // Third call: count photos → 0
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [], error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(false)
  })
})
