import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  verifyInitData: vi.fn(),
}))
// Referrals area — not under test here.
vi.mock('../src/referrals/attribution.js', () => ({
  captureReferralAttribution: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { withFailingWrites, withMissingTable } from './helpers/profile.js'

const verify = (app: Awaited<ReturnType<typeof buildApp>>, initData = 'valid_init_data') =>
  app.inject({ method: 'POST', url: '/auth/verify', payload: { initData } })

describe('POST /auth/verify', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    app = await buildApp()
  })

  it('returns 400 when initData is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing_init_data' })
  })

  it('returns 401 for invalid initData', async () => {
    vi.mocked(verifyInitData).mockReturnValue(null)

    const res = await verify(app, 'bad')

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_init_data' })
  })

  it('creates a new user and returns setupComplete: false', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await verify(app)

    expect(res.statusCode).toBe(200)
    const [row] = await sql`select id, telegram_id, username, name, age, gender, looking_for, allows_write_to_pm from users`
    expect(row).toMatchObject({
      telegram_id: 42, username: 'hamid', name: 'Hamid', age: 0, gender: 'man', looking_for: 'women',
      allows_write_to_pm: null,
    })
    expect(res.json().user).toEqual({ id: row.id, name: 'Hamid', setupComplete: false, locale: null })
  })

  it('stores allows_write_to_pm only when Telegram sent it', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', allows_write_to_pm: true } as any)
    await verify(app)
    expect((await sql`select allows_write_to_pm from users where telegram_id = 42`)[0].allows_write_to_pm).toBe(true)

    // An old client omits the field: the known value must survive.
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid' } as any)
    await verify(app)
    expect((await sql`select allows_write_to_pm from users where telegram_id = 42`)[0].allows_write_to_pm).toBe(true)
  })

  it('stores a new user without a Telegram username as username null', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 43, first_name: 'Sara' })
    expect((await verify(app)).statusCode).toBe(200)
    expect((await sql`select username from users where telegram_id = 43`)[0].username).toBeNull()
  })

  it('reactivates a soft-deleted user by clearing deleted_at and setting is_active true', async () => {
    const u = await createUser({
      telegram_id: 42, name: '', age: 0, is_active: false, deleted_at: '2026-08-01T00:00:00Z',
    })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await verify(app)

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(false)
    const [row] = await sql`select deleted_at, is_active from users where id = ${u.id}`
    expect(row).toEqual({ deleted_at: null, is_active: true })
  })

  it('does not update deleted_at or is_active for a normal existing user', async () => {
    const old = new Date(Date.now() - 86_400_000).toISOString()
    const u = await createUser({
      telegram_id: 42, name: 'Hamid', age: 25, is_active: false, last_active: old,
    })
    await createPhoto(u.id, 0, { url: 'https://example.com/hamid.jpg' })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await verify(app)

    expect(res.statusCode).toBe(200)
    expect(res.json().user.setupComplete).toBe(true)
    // Full profile comes back so the splash screen can skip a /profile/me round trip.
    expect(res.json().user.photos).toEqual([
      { id: expect.any(String), url: 'https://example.com/hamid.jpg', position: 0 },
    ])
    const [row] = await sql`select last_active, deleted_at, is_active from users where id = ${u.id}`
    expect(row.last_active).not.toBe(old)
    expect(row.deleted_at).toBeNull()
    expect(row.is_active).toBe(false)
  })

  it('returns 500 if reactivation update fails', async () => {
    await createUser({ telegram_id: 42, name: '', age: 0, deleted_at: '2026-08-01T00:00:00Z' })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await withFailingWrites('users', 'update', () => verify(app))

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'auth_update_failed' })
  })

  it('returns 500 user_creation_failed when the insert fails (thrown error is caught)', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 44, first_name: 'Hamid' })

    const res = await withFailingWrites('users', 'insert', () => verify(app))

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'user_creation_failed' })
  })

  it('treats a failed user lookup as "not found" (insert then fails → 500, never a crash)', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 45, first_name: 'Hamid' })

    const res = await withMissingTable('users', () => verify(app))

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'user_creation_failed' })
  })
})
