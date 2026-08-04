import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin ban/unban', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('bans a user', async () => {
    const update = vi.fn(() => chainable({ data: { id: 'u1' }, error: null }))
    vi.mocked(db.from).mockImplementation(() => ({ update } as any))

    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/ban', headers })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((update.mock.calls[0][0] as any).banned_at).toBeTruthy()
  })

  it('unbans a user by clearing banned_at', async () => {
    const update = vi.fn(() => chainable({ data: { id: 'u1' }, error: null }))
    vi.mocked(db.from).mockImplementation(() => ({ update } as any))

    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/unban', headers })

    expect(res.statusCode).toBe(200)
    expect(update).toHaveBeenCalledWith({ banned_at: null })
  })

  it('returns 404 for an unknown user', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      ({ update: () => chainable({ data: null, error: { message: 'not found' } }) } as any)
    )
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/ban', headers })
    expect(res.statusCode).toBe(404)
  })
})
