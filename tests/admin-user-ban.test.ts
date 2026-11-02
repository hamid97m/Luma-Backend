import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('admin ban/unban', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let user: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
    user = await createUser()
  })

  const bannedAt = async () => (await sql`select banned_at from users where id = ${user.id}`)[0].banned_at

  it('bans a user', async () => {
    const res = await app.inject({ method: 'POST', url: `/admin/users/${user.id}/ban`, headers })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await bannedAt()).toBeTruthy()
  })

  it('unbans a user by clearing banned_at', async () => {
    await sql`update users set banned_at = now() where id = ${user.id}`
    const res = await app.inject({ method: 'POST', url: `/admin/users/${user.id}/unban`, headers })

    expect(res.statusCode).toBe(200)
    expect(await bannedAt()).toBeNull()
  })

  it('returns 404 for an unknown user', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/00000000-0000-0000-0000-000000000000/ban', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('returns 404 (not 500) for a malformed id', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/ban', headers })
    expect(res.statusCode).toBe(404)
  })
})
