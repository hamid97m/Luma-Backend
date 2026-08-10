import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('../src/bot.js', () => ({}))
vi.mock('../src/jobs/fakeLiker.js', () => ({
  runFakeLikerJob: vi.fn(),
  getNextScheduledRunAt: vi.fn(() => null),
  setNextScheduledRunAt: vi.fn(),
}))

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

  it('maps an unrecognized skip reason to 500 rather than guessing a status', async () => {
    vi.mocked(runFakeLikerJob).mockResolvedValue({ skipped: 'something_else' })
    const res = await app.inject({ method: 'POST', url: '/admin/fake-liker/run', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ ok: false, error: 'something_else' })
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

  it('returns pool size, totals (via rpc), and last run', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'f1', name: 'Fake One' }, { id: 'f2', name: 'Fake Two' }], error: null })
      return chainable({ data: null })
    })
    // Postgres bigint aggregates arrive over PostgREST as strings — assert the route coerces them.
    vi.mocked(db.rpc).mockReturnValue(chainable({
      data: { total_likes_sent: '15', total_matches_created: '3', total_salams_sent: '3', last_run_at: '2026-08-05T00:00:00Z' },
      error: null,
    }))
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fakeWomenCount: 2,
      totalLikesSent: 15,
      totalMatchesCreated: 3,
      totalSalamsSent: 3,
      lastRunAt: '2026-08-05T00:00:00Z',
      nextRunAt: null,
    })
    expect(db.rpc).toHaveBeenCalledWith('fake_liker_run_totals')
  })

  it('returns zeroed stats and null lastRunAt with an empty pool/history', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [], error: null })
      return chainable({ data: null })
    })
    vi.mocked(db.rpc).mockReturnValue(chainable({
      data: { total_likes_sent: 0, total_matches_created: 0, total_salams_sent: 0, last_run_at: null },
      error: null,
    }))
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fakeWomenCount: 0,
      totalLikesSent: 0,
      totalMatchesCreated: 0,
      totalSalamsSent: 0,
      lastRunAt: null,
      nextRunAt: null,
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

  it('500s when the totals rpc fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'f1', name: 'Fake One' }], error: null })
      return chainable({ data: null })
    })
    vi.mocked(db.rpc).mockReturnValue(chainable({ data: null, error: { message: 'boom' } }))
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })
})

describe('admin fake-liker fakes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('paginates the pool and shapes each row', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'f1', name: 'Fake One' }, { id: 'f2', name: 'Fake Two' }], error: null })
      if (table === 'matches') return chainable({ data: [], error: null })
      if (table === 'swipes') return chainable({ count: 3, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [
        { id: 'f1', name: 'Fake One', likesSent: 3, matches: 0, unreadCount: 0 },
        { id: 'f2', name: 'Fake Two', likesSent: 3, matches: 0, unreadCount: 0 },
      ],
      total: 2, page: 1, pageCount: 1,
    })
  })

  it('sorts fakes with unread chats first, overriding alphabetical order', async () => {
    // "Aaron" sorts before "Zed" alphabetically, but only Zed has the unread
    // chat — if the handler ever fell back to (or dropped unread-first in
    // favor of) alphabetical order, this would fail.
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'f1', name: 'Aaron' }, { id: 'f2', name: 'Zed' }], error: null })
      if (table === 'matches') return chainable({ data: [{ id: 'm1', user1_id: 'f2', user2_id: 'real1' }], error: null })
      if (table === 'messages') return chainable({ data: [{ match_id: 'm1', sender_id: 'real1' }], error: null })
      if (table === 'swipes') return chainable({ count: 0, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes?page=1', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items[0]).toEqual({ id: 'f2', name: 'Zed', likesSent: 0, matches: 1, unreadCount: 1 })
    expect(body.items[1]).toEqual({ id: 'f1', name: 'Aaron', likesSent: 0, matches: 0, unreadCount: 0 })
  })

  it('returns an empty page for an empty pool', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [], error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it('500s when the pool fetch fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: null, error: { message: 'boom' } })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'fakes_fetch_failed' })
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
