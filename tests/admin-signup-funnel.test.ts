import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

import { buildApp } from '../src/server.js'
import { resetDb, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

type Event = { name: string; step?: string; detail?: string; created_at?: string }

/** One session's events; a shared created_at mimics a single batch insert. */
async function session(events: Event[], sessionId = randomUUID()): Promise<string> {
  await sql`insert into signup_events ${sql(events.map((e) => ({
    session_id: sessionId,
    name: e.name,
    step: e.step ?? null,
    detail: e.detail ?? null,
    created_at: e.created_at ?? ago(1000),
  })))}`
  return sessionId
}

describe('GET /admin/signup-funnel', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const funnel = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: `/admin/signup-funnel${query}`, headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/signup-funnel' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a user session token', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/signup-funnel', headers: { authorization: 'Bearer not-an-admin' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns empty lists without data', async () => {
    expect(await funnel()).toEqual({ days: 7, funnel: [], failures: [], lastStep: [] })
  })

  it('counts distinct sessions per (name, step) in natural flow order', async () => {
    const a = randomUUID()
    await session([
      { name: 'submit_ok' }, { name: 'photo_ok', step: 'photo' }, { name: 'photo_pick', step: 'photo' },
      { name: 'step_view', step: 'photo' }, { name: 'step_view', step: 'age' }, { name: 'step_view', step: 'name' },
      { name: 'step_view', step: 'name' }, { name: 'picker_done' }, { name: 'picker_view', step: 'picker' },
      { name: 'auth_ok' }, { name: 'app_open' }, { name: 'app_open' },
    ], a)
    await session([{ name: 'app_open' }, { name: 'auth_failed', detail: 'network' }, { name: 'login_view' }])
    await session([{ name: 'page_hidden' }, { name: 'photo_failed', step: 'photo' }])

    expect((await funnel()).funnel).toEqual([
      { name: 'app_open', step: null, sessions: 2 },
      { name: 'auth_ok', step: null, sessions: 1 },
      { name: 'auth_failed', step: null, sessions: 1 },
      { name: 'login_view', step: null, sessions: 1 },
      { name: 'picker_view', step: 'picker', sessions: 1 },
      { name: 'picker_done', step: null, sessions: 1 },
      { name: 'step_view', step: 'name', sessions: 1 },
      { name: 'step_view', step: 'age', sessions: 1 },
      { name: 'step_view', step: 'photo', sessions: 1 },
      { name: 'photo_pick', step: 'photo', sessions: 1 },
      { name: 'photo_ok', step: 'photo', sessions: 1 },
      { name: 'submit_ok', step: null, sessions: 1 },
    ])
  })

  it('groups failures by detail, biggest first', async () => {
    await session([
      { name: 'photo_failed', detail: 'file:401' },
      { name: 'photo_failed', detail: 'file:401' },
      { name: 'photo_failed', detail: 'file:401' },
      { name: 'auth_failed', detail: 'network' },
      { name: 'auth_failed', detail: 'network' },
      { name: 'submit_failed' },
    ])

    expect((await funnel()).failures).toEqual([
      { name: 'photo_failed', detail: 'file:401', count: 3 },
      { name: 'auth_failed', detail: 'network', count: 2 },
      { name: 'submit_failed', detail: null, count: 1 },
    ])
  })

  it('lastStep: unfinished sessions by their latest step', async () => {
    // Two sessions stuck on age; the later view wins over an earlier one.
    await session([
      { name: 'step_view', step: 'name', created_at: ago(5000) },
      { name: 'step_view', step: 'age', created_at: ago(4000) },
    ])
    await session([{ name: 'step_view', step: 'age' }])
    // Same batch (same created_at): insert order decides. Non-view events don't count.
    await session([{ name: 'step_view', step: 'city' }, { name: 'step_view', step: 'photo' }, { name: 'photo_pick', step: 'interests' }])
    // Stopped at the language picker, with and without an explicit step.
    await session([{ name: 'picker_view', step: 'picker' }])
    await session([{ name: 'picker_view' }])
    // Finished: not a drop-off, even though its last view is 'photo'.
    await session([{ name: 'step_view', step: 'photo' }, { name: 'submit_ok' }])
    // Never reached a step: nothing to attribute.
    await session([{ name: 'app_open' }])

    expect((await funnel()).lastStep).toEqual([
      { step: 'picker', sessions: 2 },
      { step: 'age', sessions: 2 },
      { step: 'photo', sessions: 1 },
    ])
  })

  it('only looks at the requested window', async () => {
    await session([{ name: 'step_view', step: 'age', created_at: ago(10 * DAY) }, { name: 'auth_failed', created_at: ago(10 * DAY) }])
    await session([{ name: 'step_view', step: 'city', created_at: ago(2 * DAY) }])

    const week = await funnel()
    expect(week.funnel).toEqual([{ name: 'step_view', step: 'city', sessions: 1 }])
    expect(week.failures).toEqual([])
    expect(week.lastStep).toEqual([{ step: 'city', sessions: 1 }])

    expect((await funnel('?days=30')).lastStep).toEqual([{ step: 'city', sessions: 1 }, { step: 'age', sessions: 1 }])
    expect((await funnel('?days=1')).funnel).toEqual([])
  })

  it.each([
    ['', 7], ['?days=', 7], ['?days=abc', 7], ['?days=0', 1], ['?days=-5', 1], ['?days=30', 30], ['?days=500', 90],
  ])('days for "%s" is %i', async (query, days) => {
    expect((await funnel(query)).days).toBe(days)
  })

  it('500s when the query fails', async () => {
    const res = await withTableBroken('signup_events', () =>
      app.inject({ method: 'GET', url: '/admin/signup-funnel', headers }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'signup_funnel_fetch_failed' })
  })
})
