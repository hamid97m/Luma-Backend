import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { signSessionToken, verifySessionToken } from '../src/session.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto } from './helpers/db.js'

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('session tokens', () => {
  it('round-trips the user id', () => {
    expect(verifySessionToken(signSessionToken('u-1'))).toBe('u-1')
  })

  it('rejects a token signed with another secret', () => {
    expect(verifySessionToken(jwt.sign({ userId: 'u-1' }, 'other-secret'))).toBeNull()
  })

  it('rejects a token without a userId', () => {
    expect(verifySessionToken(jwt.sign({ adminId: 'a' }, process.env.USER_JWT_SECRET!))).toBeNull()
  })
})

describe('Bearer session auth', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { await resetDb(); app = await buildApp() })

  it('Bearer token authenticates GET /profile/me', async () => {
    const u = await createUser({ name: 'Sara' })

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: u.id, name: 'Sara' })
  })

  it('expired token → 401 invalid_session', async () => {
    const u = await createUser()
    const token = jwt.sign({ userId: u.id }, process.env.USER_JWT_SECRET!, { expiresIn: -1 })

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: bearer(token) })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('garbage token → 401 invalid_session', async () => {
    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: bearer('not-a-jwt') })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('token for an unknown user → 401 user_not_found', async () => {
    const res = await app.inject({
      method: 'GET', url: '/profile/me',
      headers: bearer(signSessionToken('00000000-0000-0000-0000-000000000000')),
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('token for deleted user → 401 account_deleted', async () => {
    const u = await createUser({ deleted_at: '2026-10-01T00:00:00Z' })

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_deleted' })
  })

  it('token for banned user → 401 account_banned', async () => {
    const u = await createUser({ banned_at: '2026-10-01T00:00:00Z' })

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_banned', botUsername: null })
  })

  it('token for a paused user → 403 account_paused', async () => {
    const u = await createUser({ paused_at: '2026-10-01T00:00:00Z' })

    const res = await app.inject({ method: 'GET', url: '/matches', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'account_paused' })
  })

  it('GET /auth/me returns setupComplete user profile', async () => {
    const u = await createUser({ name: 'Sara', age: 26 })
    await createPhoto(u.id)

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(200)
    const { user } = res.json()
    expect(user).toMatchObject({ id: u.id, name: 'Sara', age: 26, setupComplete: true })
    expect(user.photos).toHaveLength(1)
  })

  it('GET /auth/me returns the short form before setup', async () => {
    const u = await createUser({ name: 'New', age: 0 })

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(signSessionToken(u.id)) })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ user: { id: u.id, name: 'New', setupComplete: false, locale: null } })
  })

  it('GET /auth/me without auth → 401 missing_auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_auth' })
  })

  it('initData path still works (existing AUTH helper)', async () => {
    const u = await createUser({ name: 'Ali' })
    authAs(u)

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: AUTH })
    const profile = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ id: u.id, name: 'Ali' })
    expect(profile.statusCode).toBe(200)
    expect(profile.json()).toMatchObject({ id: u.id })
  })
})
