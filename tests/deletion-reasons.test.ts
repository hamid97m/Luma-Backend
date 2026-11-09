import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withFailingWrites } from './helpers/profile.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

let app: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_JWT_SECRET = 'test-secret'
  app = await buildApp()
})

const reasonRows = () => sql`select * from account_deletion_reasons order by id`

describe('DELETE /profile/me — deletion reason', () => {
  let me: Record<string, any>

  beforeEach(async () => {
    me = await createUser({ gender: 'woman', looking_for: 'men', created_at: ago(10 * DAY + 60_000) })
    authAs(me)
  })

  const del = (payload?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: 'DELETE', url: '/profile/me', headers: { ...AUTH, ...headers }, ...(payload === undefined ? {} : { payload: payload as any }),
  })

  it('stores the reason and note with a snapshot of the user', async () => {
    await sql`update users set premium_until = ${new Date(Date.now() + DAY).toISOString()} where id = ${me.id}`

    const res = await del({ reason: 'no_replies', note: '  nobody writes back  ' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await reasonRows()).toEqual([expect.objectContaining({
      user_id: me.id, reason: 'no_replies', note: 'nobody writes back',
      gender: 'woman', was_premium: true, days_since_signup: 10,
    })])
    expect((await sql`select deleted_at from users where id = ${me.id}`)[0].deleted_at).not.toBeNull()
  })

  it('treats expired premium as not premium', async () => {
    await sql`update users set premium_until = ${ago(DAY)} where id = ${me.id}`
    await del({ reason: 'too_expensive' })
    expect((await reasonRows())[0]).toMatchObject({ reason: 'too_expensive', was_premium: false })
  })

  it('stores an unknown reason as null and keeps the note', async () => {
    await del({ reason: 'hacker', note: 'x' })
    expect((await reasonRows())[0]).toMatchObject({ reason: null, note: 'x' })
  })

  it('ignores non-string values', async () => {
    await del({ reason: 5, note: { a: 1 } })
    expect((await reasonRows())[0]).toMatchObject({ reason: null, note: null })
  })

  it('caps the note at 500 characters and stores a blank note as null', async () => {
    await del({ reason: 'other', note: 'a'.repeat(800) })
    expect((await reasonRows())[0].note).toBe('a'.repeat(500))

    const other = await createUser()
    authAs(other)
    await del({ reason: 'other', note: '   ' })
    expect((await reasonRows())[1]).toMatchObject({ reason: 'other', note: null })
  })

  it('deletes without a body and records a skipped answer', async () => {
    const res = await del()
    expect(res.statusCode).toBe(200)
    expect(await reasonRows()).toEqual([expect.objectContaining({ user_id: me.id, reason: null, note: null })])
  })

  it('does not 400 on an empty or malformed JSON body', async () => {
    const empty = await app.inject({
      method: 'DELETE', url: '/profile/me', headers: { ...AUTH, 'content-type': 'application/json' },
    })
    expect(empty.statusCode).toBe(200)

    const other = await createUser()
    authAs(other)
    const bad = await del('{not json', { 'content-type': 'application/json' })
    expect(bad.statusCode).toBe(200)
    expect((await reasonRows()).map((r) => r.reason)).toEqual([null, null])
  })

  it('still deletes when the reason insert fails', async () => {
    const res = await withFailingWrites('account_deletion_reasons', 'insert', () => del({ reason: 'buggy' }))
    expect(res.statusCode).toBe(200)
    expect((await sql`select deleted_at from users where id = ${me.id}`)[0].deleted_at).not.toBeNull()
    expect(await reasonRows()).toEqual([])
  })

  it('records nothing when the delete itself fails', async () => {
    const res = await withFailingWrites('users', 'update', () => del({ reason: 'buggy' }))
    expect(res.statusCode).toBe(500)
    expect(await reasonRows()).toEqual([])
  })
})

describe('GET /admin/deletion-reasons', () => {
  const headers = () => adminHeaders()
  const get = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: `/admin/deletion-reasons${query}`, headers: headers() })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const row = (r: Record<string, unknown>) => sql`insert into account_deletion_reasons ${sql(r)} returning id`

  it('requires an admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/deletion-reasons' })).statusCode).toBe(401)
    const res = await app.inject({
      method: 'GET', url: '/admin/deletion-reasons', headers: { authorization: 'Bearer not-an-admin' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns empty results without data', async () => {
    expect(await get()).toEqual({ days: 30, total: 0, byReason: [], recent: [] })
  })

  it('aggregates by reason with gender and premium splits within the window', async () => {
    await row({ reason: 'few_matches', gender: 'man', was_premium: false, created_at: ago(1000) })
    await row({ reason: 'few_matches', gender: 'man', was_premium: true, created_at: ago(2000) })
    await row({ reason: 'few_matches', gender: 'woman', was_premium: false, created_at: ago(3000) })
    await row({ reason: null, gender: 'woman', was_premium: false, created_at: ago(4000) })
    await row({ reason: 'buggy', gender: 'nonbinary', was_premium: false, created_at: ago(40 * DAY) })

    const body = await get()

    expect(body.total).toBe(4)
    expect(body.byReason).toEqual([
      { reason: 'few_matches', count: 3, men: 2, women: 1, premium: 1 },
      { reason: null, count: 1, men: 0, women: 1, premium: 0 },
    ])
    expect((await get('?days=90')).byReason).toContainEqual({ reason: 'buggy', count: 1, men: 0, women: 0, premium: 0 })
  })

  it('clamps days to 1..365 and defaults junk to 30', async () => {
    expect((await get('?days=0')).days).toBe(1)
    expect((await get('?days=9999')).days).toBe(365)
    expect((await get('?days=abc')).days).toBe(30)
  })

  it('lists the latest 50 rows with what is left of the user', async () => {
    const u = await createUser({ telegram_id: 777, username: 'gone_user', name: '' })
    await row({ user_id: u.id, reason: 'found_someone', note: 'met someone here', gender: 'man',
      was_premium: true, days_since_signup: 12, created_at: ago(1000) })
    for (let i = 0; i < 55; i++) await row({ reason: 'other', created_at: ago(DAY + i * 1000) })

    const { recent } = await get()

    expect(recent).toHaveLength(50)
    expect(recent[0]).toEqual({
      id: expect.any(Number), userId: u.id, userName: '', username: 'gone_user', telegramId: 777,
      reason: 'found_someone', note: 'met someone here', gender: 'man', wasPremium: true,
      daysSinceSignup: 12, createdAt: expect.any(String),
    })
    expect(recent[1]).toMatchObject({ userId: null, username: null, telegramId: null, reason: 'other' })
  })

  it('returns 500 when the table is unreadable', async () => {
    const res = await withTableBroken('account_deletion_reasons', () =>
      app.inject({ method: 'GET', url: '/admin/deletion-reasons', headers: headers() }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'deletion_reasons_fetch_failed' })
  })
})

describe('GET /admin/users/:id — deletionReasons', () => {
  it('lists the user\'s deletion answers, latest first', async () => {
    const u = await createUser()
    const other = await createUser()
    await sql`insert into account_deletion_reasons ${sql([
      { user_id: u.id, reason: 'taking_break', note: null, created_at: ago(5 * DAY) },
      { user_id: u.id, reason: 'privacy_safety', note: 'too public', created_at: ago(DAY) },
      { user_id: other.id, reason: 'buggy', note: null, created_at: ago(DAY) },
    ])}`

    const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers: adminHeaders() })

    expect(res.statusCode).toBe(200)
    expect(res.json().deletionReasons).toEqual([
      { reason: 'privacy_safety', note: 'too public', createdAt: expect.any(String) },
      { reason: 'taking_break', note: null, createdAt: expect.any(String) },
    ])
  })

  it('is an empty list for a user who never deleted', async () => {
    const u = await createUser()
    const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers: adminHeaders() })
    expect(res.json().deletionReasons).toEqual([])
  })
})
