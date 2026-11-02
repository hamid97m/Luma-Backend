import { describe, it, expect, vi, beforeEach } from 'vitest'
import bcrypt from 'bcryptjs'

import { buildApp } from '../src/server.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { resetDb, sql } from './helpers/db.js'
import { createAdmin } from './helpers/admin.js'

describe('admin auth', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
  })

  const login = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/admin/auth/login', payload: payload as any })

  it('POST /admin/auth/login returns a token for valid credentials and stamps last_login_at', async () => {
    const { admin } = await createAdmin('root', 'hunter2')

    const res = await login({ username: 'root', password: 'hunter2' })

    expect(res.statusCode).toBe(200)
    const token = res.json().token
    expect(token).toBeTruthy()
    // fire-and-forget update
    await vi.waitFor(async () => {
      const [row] = await sql`select last_login_at from admins where id = ${admin.id}`
      expect(row.last_login_at).not.toBeNull()
    })
    const me = await app.inject({ method: 'GET', url: '/admin/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.json()).toEqual({ adminId: admin.id, username: 'root' })
  })

  it('rejects a wrong password with a generic error', async () => {
    await createAdmin('root', 'hunter2')
    const res = await login({ username: 'root', password: 'wrong' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('rejects an unknown username with the same generic error', async () => {
    const res = await login({ username: 'ghost', password: 'x' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('treats a non-string username as an unknown user (no 500)', async () => {
    const res = await login({ username: { $ne: null }, password: 'x' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('runs bcrypt against a dummy hash for unknown usernames (constant-time login)', async () => {
    const compareSpy = vi.spyOn(bcrypt, 'compare')

    const res = await login({ username: 'ghost', password: 'x' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
    // Always exactly one bcrypt run — equalizes timing between known and
    // unknown usernames and prevents enumeration via response latency.
    expect(compareSpy).toHaveBeenCalledTimes(1)

    compareSpy.mockRestore()
  })

  it('returns 400 when credentials are missing', async () => {
    const res = await login({})
    expect(res.statusCode).toBe(400)
  })

  it('returns 503 when ADMIN_JWT_SECRET is not configured', async () => {
    delete process.env.ADMIN_JWT_SECRET
    const res = await login({ username: 'root', password: 'x' })
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

  it('rate limits repeated login attempts from the same IP regardless of Authorization header', async () => {
    // app.inject uses the same default remoteAddress for every call against
    // this single app instance, so the IP-keyed bucket accumulates across requests.
    for (let i = 0; i < 10; i++) {
      const res = await login({ username: 'ghost', password: 'x' })
      expect(res.statusCode).toBe(401)
    }

    const res = await login({ username: 'ghost', password: 'x' })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'rate_limited' })
  })
})
