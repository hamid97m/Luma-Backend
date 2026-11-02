import { describe, it, expect, beforeEach } from 'vitest'
import { signIn, normalizeEmail } from '../src/accounts.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'

const google = (over: Partial<{ sub: string; email: string; givenName: string }> = {}) =>
  ({ kind: 'google' as const, sub: 'g-1', email: 'ali@gmail.com', givenName: 'Ali', ...over })

describe('signIn', () => {
  beforeEach(async () => { await resetDb() })

  it('google creates a new user with email and google_sub', async () => {
    const res = await signIn(google())

    expect(res.ok).toBe(true)
    const rows = await sql`select id, telegram_id, email, google_sub, name, age, gender, looking_for from users`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      telegram_id: null, email: 'ali@gmail.com', google_sub: 'g-1', name: 'Ali',
      age: 0, gender: 'man', looking_for: 'women',
    })
    if (!res.ok) return
    expect(res.userId).toBe(rows[0].id)
    expect(res.user).toEqual({ id: rows[0].id, name: 'Ali', setupComplete: false, locale: null })
  })

  it('google matches existing email-only user and attaches google_sub', async () => {
    const u = await createUser({ telegram_id: null, email: 'ali@gmail.com', name: 'Ali' })

    const res = await signIn(google({ sub: 'g-2' }))

    expect(res.ok && res.userId).toBe(u.id)
    const rows = await sql`select id, google_sub from users`
    expect(rows).toEqual([{ id: u.id, google_sub: 'g-2' }])
  })

  it('google sign-in normalizes the email (" Ali@Gmail.COM ")', async () => {
    const first = await signIn(google({ email: '  Ali@Gmail.COM ' }))
    expect((await sql`select email from users`)[0].email).toBe('ali@gmail.com')

    // A different Google account with the same address matches by email.
    await sql`update users set google_sub = null`
    const second = await signIn(google({ sub: 'g-9', email: 'ALI@gmail.com' }))
    expect(second.ok && first.ok && second.userId).toBe(first.ok && first.userId)
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(1)
  })

  it('email-matched user already tied to another Google account → 401 google_account_mismatch', async () => {
    const u = await createUser({ telegram_id: null, email: 'ali@gmail.com', google_sub: 'g-old' })

    const res = await signIn(google({ sub: 'g-new' }))

    expect(res).toEqual({ ok: false, status: 401, body: { error: 'google_account_mismatch' } })
    // No re-link, no new account.
    const rows = await sql`select id, google_sub from users`
    expect(rows).toEqual([{ id: u.id, google_sub: 'g-old' }])
  })

  it('banned email-matched user → ok:false 401 account_banned', async () => {
    await createUser({ telegram_id: null, email: 'ali@gmail.com', banned_at: '2026-08-04T00:00:00Z' })

    const res = await signIn(google())

    expect(res).toEqual({ ok: false, status: 401, body: { error: 'account_banned', botUsername: null } })
    // Rejected before any write: google_sub not attached.
    expect((await sql`select google_sub from users`)[0].google_sub).toBeNull()
  })

  it('deleted google user is reactivated (deleted_at null, is_active true)', async () => {
    const u = await createUser({
      telegram_id: null, google_sub: 'g-1', email: 'ali@gmail.com',
      is_active: false, deleted_at: '2026-08-01T00:00:00Z',
    })

    const res = await signIn(google())

    expect(res.ok && res.userId).toBe(u.id)
    const [row] = await sql`select deleted_at, is_active from users where id = ${u.id}`
    expect(row).toEqual({ deleted_at: null, is_active: true })
  })

  it('telegram path returns the same user shape as before for a setupComplete user', async () => {
    const u = await createUser({ telegram_id: 42, name: 'Hamid', age: 25 })
    await createPhoto(u.id, 0, { url: 'https://example.com/hamid.jpg' })

    const res = await signIn({ kind: 'telegram', tgUser: { id: 42, first_name: 'Hamid' } })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.userId).toBe(u.id)
    expect(res.user).toMatchObject({
      id: u.id, name: 'Hamid', age: 25, setupComplete: true, paused: false,
      photos: [{ id: expect.any(String), url: 'https://example.com/hamid.jpg', position: 0 }],
    })
  })
})

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Ali@Gmail.COM ')).toBe('ali@gmail.com')
  })
})
