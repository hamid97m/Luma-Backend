import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { hashPassword, signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin auth', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
  })

  it('POST /admin/auth/login returns a token for valid credentials', async () => {
    const password_hash = await hashPassword('hunter2')
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: { id: 'admin-1', username: 'root', password_hash }, error: null })
    )

    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { username: 'root', password: 'hunter2' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().token).toBeTruthy()
  })

  it('rejects a wrong password with a generic error', async () => {
    const password_hash = await hashPassword('hunter2')
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: { id: 'admin-1', username: 'root', password_hash }, error: null })
    )
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { username: 'root', password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('rejects an unknown username with the same generic error', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: null, error: { message: 'not found' } })
    )
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { username: 'ghost', password: 'x' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('returns 400 when credentials are missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/auth/login', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('returns 503 when ADMIN_JWT_SECRET is not configured', async () => {
    delete process.env.ADMIN_JWT_SECRET
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { username: 'root', password: 'x' },
    })
    expect(res.statusCode).toBe(503)
  })

  it('guard rejects /admin/me without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_token' })
  })

  it('guard rejects an invalid token', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/me',
      headers: { authorization: 'Bearer garbage' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_token' })
  })

  it('guard accepts a valid token and /admin/me returns the admin identity', async () => {
    const token = signAdminToken({ adminId: 'admin-1', username: 'root' })
    const res = await app.inject({
      method: 'GET', url: '/admin/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ adminId: 'admin-1', username: 'root' })
  })
})
