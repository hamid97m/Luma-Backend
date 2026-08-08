import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

function mockUsers({
  fetch = { data: { id: 'u1', is_seed: true }, error: null },
  update = vi.fn(() => chainable({ error: null })),
} = {}) {
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return { select: () => chainable(fetch), update } as any
    return chainable({ data: null })
  })
  return { update }
}

describe('DELETE /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/admin/users/u1' })
    expect(res.statusCode).toBe(401)
  })

  it('404s for an unknown user', async () => {
    const { update } = mockUsers({ fetch: { data: null, error: { message: 'not found' } } })
    const res = await app.inject({ method: 'DELETE', url: '/admin/users/nope', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
    expect(update).not.toHaveBeenCalled()
  })

  it('400s for a real (non-seed) user', async () => {
    const { update } = mockUsers({ fetch: { data: { id: 'u1', is_seed: false }, error: null } })
    const res = await app.inject({ method: 'DELETE', url: '/admin/users/u1', headers })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_a_seed_user' })
    expect(update).not.toHaveBeenCalled()
  })

  it('soft-deletes a seed user: sets deleted_at and is_active false', async () => {
    const { update } = mockUsers()
    const res = await app.inject({ method: 'DELETE', url: '/admin/users/u1', headers })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(update).toHaveBeenCalledTimes(1)
    const patch = update.mock.calls[0][0] as any
    expect(patch.is_active).toBe(false)
    expect(typeof patch.deleted_at).toBe('string')
    expect(Number.isNaN(Date.parse(patch.deleted_at))).toBe(false)
    expect(Object.keys(patch).sort()).toEqual(['deleted_at', 'is_active'])
  })

  it('500s when the update fails', async () => {
    mockUsers({ update: vi.fn(() => chainable({ error: { message: 'db down' } })) })
    const res = await app.inject({ method: 'DELETE', url: '/admin/users/u1', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'delete_failed' })
  })
})
