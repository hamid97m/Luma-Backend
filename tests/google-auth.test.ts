import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/googleAuth.js', () => ({ verifyGoogleIdToken: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyGoogleIdToken } from '../src/googleAuth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('POST /auth/google', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
  })

  // No Authorization header anywhere below: the auth preHandler must skip this route.
  const login = (payload?: object) => app.inject({ method: 'POST', url: '/auth/google', payload })

  it('valid credential creates user and returns token', async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: 'g-1', email: 'ali@gmail.com', givenName: 'Ali' })

    const res = await login({ credential: 'id-token' })

    expect(res.statusCode).toBe(200)
    expect(verifyGoogleIdToken).toHaveBeenCalledWith('id-token')
    const [row] = await sql`select id, email, google_sub, name from users`
    expect(row).toMatchObject({ email: 'ali@gmail.com', google_sub: 'g-1', name: 'Ali' })
    const { token, user } = res.json()
    expect(user).toEqual({ id: row.id, name: 'Ali', setupComplete: false, locale: null })
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.json().user).toMatchObject({ id: row.id })
  })

  it('signs in an existing google user', async () => {
    const u = await createUser({ telegram_id: null, email: 'ali@gmail.com', google_sub: 'g-1', name: 'Ali' })
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: 'g-1', email: 'ali@gmail.com', givenName: 'Ali' })

    const res = await login({ credential: 'id-token' })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: u.id })
  })

  it('unverified/invalid credential → 401', async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(null)

    const res = await login({ credential: 'bad' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_google_login' })
    expect(await sql`select id from users`).toHaveLength(0)
  })

  it('missing credential → 400', async () => {
    for (const payload of [undefined, {}, { credential: '' }, { credential: 42 }]) {
      const res = await login(payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'missing_credential' })
    }
    expect(verifyGoogleIdToken).not.toHaveBeenCalled()
  })

  it('email tied to another Google account → 401 google_account_mismatch', async () => {
    await createUser({ telegram_id: null, email: 'ali@gmail.com', google_sub: 'g-old' })
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: 'g-new', email: 'ali@gmail.com', givenName: 'Ali' })

    const res = await login({ credential: 'id-token' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'google_account_mismatch' })
  })
})
