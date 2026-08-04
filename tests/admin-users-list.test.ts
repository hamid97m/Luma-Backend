import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const USER_ROW = {
  id: 'u1', telegram_id: 42, username: 'sara', name: 'Sara', age: 24,
  gender: 'woman', is_active: true, is_seed: false, banned_at: null,
  deleted_at: null, created_at: '2026-08-01T00:00:00Z', last_active: '2026-08-04T00:00:00Z',
}

describe('GET /admin/users', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users' })
    expect(res.statusCode).toBe(401)
  })

  it('returns camelCase items with pagination math', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: [USER_ROW], count: 42, error: null })
    )

    const res = await app.inject({ method: 'GET', url: '/admin/users?page=2', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items[0]).toEqual({
      id: 'u1', telegramId: 42, username: 'sara', name: 'Sara', age: 24,
      gender: 'woman', isActive: true, isSeed: false, bannedAt: null,
      deletedAt: null, createdAt: '2026-08-01T00:00:00Z', lastActive: '2026-08-04T00:00:00Z',
    })
    expect(body.total).toBe(42)
    expect(body.page).toBe(2)
    expect(body.pageCount).toBe(3)
  })

  it('accepts query and status params and returns an empty page', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: [], count: 0, error: null })
    )

    const res = await app.inject({
      method: 'GET', url: '/admin/users?query=sara&status=banned&page=1', headers,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it('returns 500 on a database error', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: null, count: null, error: { message: 'boom' } })
    )
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers })
    expect(res.statusCode).toBe(500)
  })
})
