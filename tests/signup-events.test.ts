import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { verifyInitData } from '../src/auth.js'
import { registry } from '../src/metrics.js'
import { buildApp } from '../src/server.js'
import { signSessionToken } from '../src/session.js'
import { AUTH, authAs } from './helpers/auth.js'
import { withTableBroken } from './helpers/admin-db-fault.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('POST /signup-events', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  const sessionId = '0b9c1f6e-4b1a-4c55-9d7e-0123456789ab'

  beforeEach(async () => {
    await resetDb()
    vi.mocked(verifyInitData).mockReset()
    app = await buildApp()
  })

  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/signup-events', payload: payload as object, headers })

  const body = (events: unknown[], over: Record<string, unknown> = {}) => ({ sessionId, events, ...over })
  const rows = () => sql`select * from signup_events order by id`

  it('accepts events without auth and stores them', async () => {
    const res = await post(body(
      [{ name: 'auth_failed', detail: 'telegram:409' }, { name: 'step_view', step: 'city' }],
      { platform: 'telegram', locale: 'fa' },
    ))

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(await rows()).toMatchObject([
      { session_id: sessionId, user_id: null, name: 'auth_failed', step: null, detail: 'telegram:409', platform: 'telegram', locale: 'fa' },
      { session_id: sessionId, user_id: null, name: 'step_view', step: 'city', detail: null, platform: 'telegram', locale: 'fa' },
    ])
  })

  it('attaches user_id from valid initData', async () => {
    const user = await createUser()
    authAs(user as { telegram_id: number })

    expect((await post(body([{ name: 'auth_ok' }]), AUTH)).statusCode).toBe(204)
    expect((await rows())[0].user_id).toBe(user.id)
  })

  it('attaches user_id from a valid session token', async () => {
    const user = await createUser({ telegram_id: null, email: 'a@b.co' })
    const headers = { authorization: `Bearer ${signSessionToken(user.id)}` }

    expect((await post(body([{ name: 'auth_ok' }]), headers)).statusCode).toBe(204)
    expect((await rows())[0].user_id).toBe(user.id)
  })

  it('never touches the user it attributes to', async () => {
    const lastActive = '2026-01-01T00:00:00.000Z'
    const user = await createUser({ last_active: lastActive, deleted_at: lastActive, notified_offline_at: lastActive })
    authAs(user as { telegram_id: number })

    await post(body([{ name: 'auth_ok' }]), AUTH)

    await new Promise((r) => setTimeout(r, 50)) // the auth hook's last_active update is fire-and-forget
    const [after] = await sql`select last_active, deleted_at, notified_offline_at from users where id = ${user.id}`
    expect(after).toEqual({ last_active: lastActive, deleted_at: lastActive, notified_offline_at: lastActive })
  })

  it.each([
    ['garbage initData', () => { vi.mocked(verifyInitData).mockReturnValue(null); return AUTH }],
    ['a verifier that throws', () => { vi.mocked(verifyInitData).mockImplementation(() => { throw new RangeError('bad hash') }); return AUTH }],
    ['a bad session token', () => ({ authorization: 'Bearer nope' })],
    ['a token for a user that no longer exists', () => ({ authorization: `Bearer ${signSessionToken(randomUUID())}` })],
    ['initData of an unknown user', () => { vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'New' } as any); return AUTH }],
  ])('stores null user_id for %s, never rejects', async (_label, headers) => {
    const res = await post(body([{ name: 'auth_failed' }]), headers())

    expect(res.statusCode).toBe(204)
    expect(await rows()).toMatchObject([{ user_id: null, name: 'auth_failed' }])
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(0)
  })

  it('drops unknown event names; all-unknown is still a success', async () => {
    expect((await post(body([{ name: 'app_open' }, { name: 'hacked' }, { name: 'constructor' }]))).statusCode).toBe(204)
    expect((await rows()).map((r) => r.name)).toEqual(['app_open'])

    expect((await post(body([{ name: 'hacked' }]))).statusCode).toBe(204)
    expect(await rows()).toHaveLength(1)
  })

  it('nulls anything that could be free text', async () => {
    const res = await post(body([
      { name: 'photo_failed', detail: 'file:401' },
      { name: 'photo_failed', detail: 'Ali from Tehran' },
      { name: 'photo_failed', detail: 'a'.repeat(33) },
      { name: 'photo_failed', detail: 42 },
      { name: 'step_view', step: 'my name is Ali' },
    ], { platform: 'desktop', locale: 'hello world' }))

    expect(res.statusCode).toBe(204)
    const stored = await rows()
    expect(stored.map((r) => r.detail)).toEqual(['file:401', null, null, null, null])
    expect(stored[4].step).toBeNull()
    expect(stored[0]).toMatchObject({ platform: null, locale: null })
  })

  it.each([
    ['a non-uuid session', { sessionId: 'abc', events: [{ name: 'app_open' }] }],
    ['no events', { sessionId }],
    ['events that are not an array', { sessionId, events: 'app_open' }],
    ['an empty batch', body([])],
    ['more than 20 events', body(Array.from({ length: 21 }, () => ({ name: 'app_open' })))],
    ['a non-object event', body(['app_open'])],
    ['a non-string name', body([{ name: 1 }])],
  ])('rejects %s with invalid_events', async (_label, payload) => {
    const res = await post(payload)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_events' })
    expect(await rows()).toHaveLength(0)
  })

  it('accepts a full batch of 20', async () => {
    expect((await post(body(Array.from({ length: 20 }, () => ({ name: 'app_open' }))))).statusCode).toBe(204)
    expect(await rows()).toHaveLength(20)
  })

  it.each([
    ['broken JSON', '{"sessionId":', 'application/json'],
    ['an empty JSON body', '', 'application/json'],
    ['an oversized body', JSON.stringify(body([{ name: 'x'.repeat(9000) }])), 'application/json'],
    ['an unsupported content type', 'x', 'application/xml'],
  ])('answers %s with invalid_events', async (_label, payload, contentType) => {
    const res = await app.inject({ method: 'POST', url: '/signup-events', payload, headers: { 'content-type': contentType } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_events' })
  })

  it('still answers 204 when the insert fails', async () => {
    const res = await withTableBroken('signup_events', () => post(body([{ name: 'app_open' }])))

    expect(res.statusCode).toBe(204)
  })

  it('limits by IP even when the Authorization header changes', async () => {
    vi.mocked(verifyInitData).mockReturnValue(null)
    for (let i = 0; i < 60; i++) {
      expect((await post(body([{ name: 'hacked' }]), { authorization: `made-up-${i}` })).statusCode).toBe(204)
    }

    const res = await post(body([{ name: 'hacked' }]), { authorization: 'made-up-last' })

    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'rate_limited' })
  })

  it('counts accepted events by name and step, without detail', async () => {
    await post(body([{ name: 'step_view', step: 'interests', detail: 'file:401' }, { name: 'page_hidden' }, { name: 'hacked' }]))

    const out = await registry.getSingleMetricAsString('luma_signup_events_total')
    expect(out).toMatch(/luma_signup_events_total\{name="step_view",step="interests"\} 1/)
    expect(out).toMatch(/luma_signup_events_total\{name="page_hidden",step=""\} 1/)
    expect(out).not.toContain('hacked')
    expect(out).not.toContain('detail')
  })
})
