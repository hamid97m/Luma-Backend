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
    vi.clearAllMocks()
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
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    } as any)
    // Second call: insert new user
    mockFrom.mockReturnValueOnce({
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-1', name: 'Hamid' }, error: null }) }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(false)
  })

  it('reactivates a soft-deleted user by clearing deleted_at and setting is_active true', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ data: null, error: null }) })
    const mockFrom = vi.mocked(db.from)
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({
        data: { id: 'uuid-1', name: '', age: 0, gender: 'man', looking_for: 'women', bio: null, deleted_at: '2026-08-01T00:00:00Z' },
        error: null,
      }) }) }),
    } as any)
    mockFrom.mockReturnValueOnce({ update: updateMock } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(false)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: null, is_active: true }))
  })

  it('does not update deleted_at or is_active for a normal existing user', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ data: null, error: null }) })
    const mockFrom = vi.mocked(db.from)
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({
        data: { id: 'uuid-1', name: 'Hamid', age: 25, gender: 'man', looking_for: 'women', bio: null, deleted_at: null },
        error: null,
      }) }) }),
    } as any)
    mockFrom.mockReturnValueOnce({ update: updateMock } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(true)
    expect(updateMock).toHaveBeenCalled()
    expect(updateMock.mock.calls[0][0]).toHaveProperty('last_active')
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('deleted_at')
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('is_active')
  })

  it('returns 500 if reactivation update fails', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ data: null, error: { message: 'update failed' } }) })
    const mockFrom = vi.mocked(db.from)
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({
        data: { id: 'uuid-1', name: '', age: 0, gender: 'man', looking_for: 'women', bio: null, deleted_at: '2026-08-01T00:00:00Z' },
        error: null,
      }) }) }),
    } as any)
    mockFrom.mockReturnValueOnce({ update: updateMock } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'auth_update_failed' })
  })
})
