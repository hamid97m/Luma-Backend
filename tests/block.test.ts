import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('POST /block', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let target: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ name: 'Ali' })
    target = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
  })

  const block = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/block', headers: AUTH, payload: payload as any })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/block', payload: { userId: target.id } })
    expect(res.statusCode).toBe(401)
  })

  it('inserts a block row and returns ok', async () => {
    authAs(me)
    const res = await block({ userId: target.id })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const rows = await sql`select blocker_id, blocked_id from blocks`
    expect(rows).toEqual([{ blocker_id: me.id, blocked_id: target.id }])
  })

  it('rejects blocking yourself', async () => {
    authAs(me)
    const res = await block({ userId: me.id })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'cannot_block_self' })
  })

  it('rejects a missing userId', async () => {
    authAs(me)
    const res = await block({})
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_block' })
  })

  it('returns 404 when the target user does not exist', async () => {
    authAs(me)
    const res = await block({ userId: '00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('returns 404 (not 500) for a malformed id', async () => {
    authAs(me)
    const res = await block({ userId: 'not-a-uuid' })
    expect(res.statusCode).toBe(404)
  })

  it('is idempotent when the block already exists', async () => {
    authAs(me)
    expect((await block({ userId: target.id })).statusCode).toBe(200)
    expect((await block({ userId: target.id })).statusCode).toBe(200)
    expect((await sql`select count(*)::int as n from blocks`)[0].n).toBe(1)
  })
})

describe('auth preHandler (real DB)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { await resetDb(); app = await buildApp() })

  it('401 user_not_found when no row matches the Telegram id', async () => {
    authAs({ telegram_id: 424242 })
    const res = await app.inject({ method: 'POST', url: '/block', headers: AUTH, payload: {} })
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('401 account_banned for a banned user', async () => {
    const u = await createUser({ banned_at: new Date().toISOString() })
    authAs(u)
    const res = await app.inject({ method: 'POST', url: '/block', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'account_banned' })
  })

  it('403 account_paused for a paused user on a non-exempt route', async () => {
    const u = await createUser({ paused_at: new Date().toISOString() })
    authAs(u)
    const res = await app.inject({ method: 'POST', url: '/block', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(403)
  })

  it('refreshes a stale last_active and clears notified_offline_at', async () => {
    const u = await createUser({
      last_active: new Date(Date.now() - 10 * 60_000).toISOString(),
      notified_offline_at: new Date().toISOString(),
    })
    authAs(u)
    await app.inject({ method: 'POST', url: '/block', headers: AUTH, payload: {} })
    await new Promise((r) => setTimeout(r, 50)) // fire-and-forget update
    const [row] = await sql`select last_active, notified_offline_at from users where id = ${u.id}`
    expect(Date.now() - new Date(row.last_active).getTime()).toBeLessThan(5_000)
    expect(row.notified_offline_at).toBeNull()
  })
})
