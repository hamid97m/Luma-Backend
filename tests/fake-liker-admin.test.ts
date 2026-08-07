import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({}))
vi.mock('../src/jobs/fakeLiker.js', () => ({ runFakeLikerJob: vi.fn() }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { runFakeLikerJob } from '../src/jobs/fakeLiker.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin fake-liker config', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the config', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'fake_liker_config'
        ? chainable({ data: { enabled: true, max_targets_per_run: 50 }, error: null })
        : chainable({ data: null }))
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, maxTargetsPerRun: 50 })
  })

  it('500s when the config row is missing', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null, error: { message: 'relation does not exist' } }))
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('updates enabled + maxTargetsPerRun', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') {
        return {
          update: (p: any) => { updates.push(p); return chainable({ data: { enabled: true, max_targets_per_run: 200 }, error: null }) },
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'PUT', url: '/admin/fake-liker/config', headers,
      payload: { enabled: true, maxTargetsPerRun: 200 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, maxTargetsPerRun: 200 })
    expect(updates[0]).toMatchObject({ enabled: true, max_targets_per_run: 200 })
  })

  it('allows a partial patch (enabled only)', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') {
        return {
          update: (p: any) => { updates.push(p); return chainable({ data: { enabled: false, max_targets_per_run: 100 }, error: null }) },
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { enabled: false } })
    expect(res.statusCode).toBe(200)
    expect(updates[0]).toMatchObject({ enabled: false })
    expect(updates[0]).not.toHaveProperty('max_targets_per_run')
  })

  it('rejects a non-boolean enabled', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { enabled: 'yes' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_enabled' })
  })

  it.each([0, 1001, 1.5, 'ten'])('rejects an out-of-range/non-integer maxTargetsPerRun (%s)', async (val) => {
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { maxTargetsPerRun: val } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_max_targets_per_run' })
  })

  it('500s when the update fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') return { update: () => chainable({ data: null, error: { message: 'db down' } }) } as any
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { enabled: true } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_update_failed' })
  })
})

describe('admin fake-liker run', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('runs the job manually and returns stats', async () => {
    const stats = { likesSent: 3, matchesCreated: 1, salamsSent: 1, skipped: 0, errors: 0 }
    vi.mocked(runFakeLikerJob).mockResolvedValue(stats)
    const res = await app.inject({ method: 'POST', url: '/admin/fake-liker/run', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, stats })
    expect(runFakeLikerJob).toHaveBeenCalledWith('manual', expect.anything())
  })

  it('maps a disabled config to 403', async () => {
    vi.mocked(runFakeLikerJob).mockResolvedValue({ skipped: 'disabled' })
    const res = await app.inject({ method: 'POST', url: '/admin/fake-liker/run', headers })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: 'disabled' })
  })

  it('maps an already-running job to 409', async () => {
    vi.mocked(runFakeLikerJob).mockResolvedValue({ skipped: 'already_running' })
    const res = await app.inject({ method: 'POST', url: '/admin/fake-liker/run', headers })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ ok: false, error: 'already_running' })
  })
})

describe('admin fake-liker stats', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('returns pool size, totals, last run, and per-fake breakdown', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'f1', name: 'Fake One' }, { id: 'f2', name: 'Fake Two' }], error: null })
      if (table === 'fake_liker_runs') {
        return chainable({
          data: [
            { started_at: '2026-08-01T00:00:00Z', likes_sent: 10, matches_created: 2, salams_sent: 2 },
            { started_at: '2026-08-05T00:00:00Z', likes_sent: 5, matches_created: 1, salams_sent: 1 },
          ],
          error: null,
        })
      }
      if (table === 'swipes') return chainable({ count: 4, error: null })
      if (table === 'matches') return chainable({ count: 2, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fakeWomenCount: 2,
      totalLikesSent: 15,
      totalMatchesCreated: 3,
      totalSalamsSent: 3,
      lastRunAt: '2026-08-05T00:00:00Z',
      perFake: [
        { id: 'f1', name: 'Fake One', likesSent: 4, matches: 2 },
        { id: 'f2', name: 'Fake Two', likesSent: 4, matches: 2 },
      ],
    })
  })

  it('returns zeroed stats and null lastRunAt with an empty pool/history', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [], error: null })
      if (table === 'fake_liker_runs') return chainable({ data: [], error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fakeWomenCount: 0,
      totalLikesSent: 0,
      totalMatchesCreated: 0,
      totalSalamsSent: 0,
      lastRunAt: null,
      perFake: [],
    })
  })

  it('500s when the pool fetch fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: null, error: { message: 'boom' } })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })
})

describe('admin fake-liker runs', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('lists runs newest-first, camelCased, with pagination', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_runs') {
        return chainable({
          data: [{
            id: 'r1', trigger: 'manual', started_at: '2026-08-05T00:00:00Z', finished_at: '2026-08-05T00:01:00Z',
            likes_sent: 10, matches_created: 2, salams_sent: 2, errors: 0,
          }],
          count: 1, error: null,
        })
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/runs?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        id: 'r1', trigger: 'manual', startedAt: '2026-08-05T00:00:00Z', finishedAt: '2026-08-05T00:01:00Z',
        likesSent: 10, matchesCreated: 2, salamsSent: 2, errors: 0,
      }],
      total: 1, page: 1, pageCount: 1,
    })
  })

  it('500s when the runs fetch fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_runs') return chainable({ data: null, count: null, error: { message: 'boom' } })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/runs', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'runs_fetch_failed' })
  })
})
