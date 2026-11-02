import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/bot.js', () => ({}))
vi.mock('../src/jobs/fakeLiker.js', () => ({
  runFakeLikerJob: vi.fn(),
  getNextScheduledRunAt: vi.fn(() => null),
  setNextScheduledRunAt: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { runFakeLikerJob } from '../src/jobs/fakeLiker.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { failOn, failReadsOf, clearFailures } from './helpers/bot-support.js'

let fakeTg = -1000
/** A fake-pool member: active, non-banned woman seed (negative sentinel telegram id). */
const createFake = (name: string, overrides: Record<string, unknown> = {}) =>
  createUser({ name, is_seed: true, gender: 'woman', looking_for: 'men', telegram_id: fakeTg--, ...overrides })

const like = (swiper_id: string, swiped_id: string) => insertRow('swipes', { swiper_id, swiped_id, direction: 'like' })

let app: Awaited<ReturnType<typeof buildApp>>
let headers: Record<string, string>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  headers = adminHeaders()
})
afterEach(clearFailures)

describe('admin fake-liker config', () => {
  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the config', async () => {
    await sql`update fake_liker_config set enabled = true, max_targets_per_run = 50`
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, maxTargetsPerRun: 50 })
  })

  it('500s when the config row is missing', async () => {
    await sql`delete from fake_liker_config`
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('updates enabled + maxTargetsPerRun', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/fake-liker/config', headers,
      payload: { enabled: true, maxTargetsPerRun: 200 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, maxTargetsPerRun: 200 })
    const [row] = await sql`select enabled, max_targets_per_run from fake_liker_config`
    expect(row).toEqual({ enabled: true, max_targets_per_run: 200 })
  })

  it('allows a partial patch (enabled only)', async () => {
    await sql`update fake_liker_config set enabled = true, max_targets_per_run = 33`
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { enabled: false } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false, maxTargetsPerRun: 33 })
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
    await failOn('fake_liker_config', 'update')
    const res = await app.inject({ method: 'PUT', url: '/admin/fake-liker/config', headers, payload: { enabled: true } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_update_failed' })
  })
})

describe('admin fake-liker run', () => {
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
  const run = (started_at: string, likes_sent: number, matches_created: number, salams_sent: number) =>
    insertRow('fake_liker_runs', { trigger: 'schedule', started_at, finished_at: started_at, likes_sent, matches_created, salams_sent })

  it('returns pool size, totals (via fake_liker_run_totals), and last run', async () => {
    await createFake('Fake One')
    await createFake('Fake Two')
    // Not in the pool: inactive / banned / man seed / real woman.
    await createFake('Inactive', { is_active: false })
    await createFake('Banned', { banned_at: new Date().toISOString() })
    await createUser({ is_seed: true, gender: 'man', telegram_id: -5 })
    await createUser({ gender: 'woman', looking_for: 'men' })
    await run('2026-08-04T00:00:00.000Z', 10, 2, 2)
    await run('2026-08-05T00:00:00.000Z', 5, 1, 1)

    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    // bigint aggregates must come back as numbers.
    expect(res.json()).toEqual({
      fakeWomenCount: 2,
      totalLikesSent: 15,
      totalMatchesCreated: 3,
      totalSalamsSent: 3,
      lastRunAt: '2026-08-05T00:00:00.000Z',
      nextRunAt: null,
    })
  })

  it('returns zeroed stats and null lastRunAt with an empty pool/history', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fakeWomenCount: 0, totalLikesSent: 0, totalMatchesCreated: 0, totalSalamsSent: 0, lastRunAt: null, nextRunAt: null,
    })
  })

  it('500s when the pool fetch fails', async () => {
    await failReadsOf('users')
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })

  it('500s when the totals function fails', async () => {
    await createFake('Fake One')
    await failReadsOf('fake_liker_runs')
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/stats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })
})

describe('admin fake-liker fakes', () => {
  it('paginates the pool and shapes each row', async () => {
    const f1 = await createFake('Fake One')
    const f2 = await createFake('Fake Two')
    const real = await createUser()
    const real2 = await createUser()
    const real3 = await createUser()
    for (const r of [real, real2, real3]) {
      await like(f1.id, r.id)
      await like(f2.id, r.id)
    }
    await insertRow('swipes', { swiper_id: f1.id, swiped_id: (await createUser()).id, direction: 'pass' })

    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [
        { id: f1.id, name: 'Fake One', likesSent: 3, matches: 0, unreadCount: 0 },
        { id: f2.id, name: 'Fake Two', likesSent: 3, matches: 0, unreadCount: 0 },
      ],
      total: 2, page: 1, pageCount: 1,
    })
  })

  it('sorts fakes with unread chats first, overriding alphabetical order', async () => {
    // "Aaron" sorts before "Zed" alphabetically, but only Zed has the unread
    // chat — if the handler ever fell back to (or dropped unread-first in
    // favor of) alphabetical order, this would fail.
    const aaron = await createFake('Aaron')
    const zed = await createFake('Zed')
    const real1 = await createUser()
    const m1 = await createMatch(zed.id, real1.id)
    await insertRow('messages', { match_id: m1.id, sender_id: real1.id, body: 'hey' })
    // Zed's own message and a read message don't count.
    await insertRow('messages', { match_id: m1.id, sender_id: zed.id, body: 'salam' })

    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes?page=1', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items[0]).toEqual({ id: zed.id, name: 'Zed', likesSent: 0, matches: 1, unreadCount: 1 })
    expect(body.items[1]).toEqual({ id: aaron.id, name: 'Aaron', likesSent: 0, matches: 0, unreadCount: 0 })
  })

  it('counts matches on either side, and ignores fake↔fake matches for unread', async () => {
    const a = await createFake('A')
    const b = await createFake('B')
    const real = await createUser()
    await createMatch(real.id, a.id) // fake on user2 side
    const ff = await createMatch(a.id, b.id)
    await insertRow('messages', { match_id: ff.id, sender_id: b.id, body: 'x' })
    const body = (await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })).json()
    expect(body.items).toEqual([
      { id: a.id, name: 'A', likesSent: 0, matches: 2, unreadCount: 0 },
      { id: b.id, name: 'B', likesSent: 0, matches: 1, unreadCount: 0 },
    ])
  })

  it('ignores icebreaker rows and read messages when counting unread chats', async () => {
    const zed = await createFake('Zed')
    const real1 = await createUser()
    const m1 = await createMatch(zed.id, real1.id)
    await insertRow('messages', { match_id: m1.id, sender_id: real1.id, body: 'q', type: 'icebreaker' })
    await insertRow('messages', { match_id: m1.id, sender_id: real1.id, body: 'old', read_at: new Date().toISOString() })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ id: zed.id, unreadCount: 0, matches: 1 })
  })

  it('returns an empty page for an empty pool', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it('500s when the pool fetch fails', async () => {
    await failReadsOf('users')
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'fakes_fetch_failed' })
  })

  it('500s when the matches fetch fails', async () => {
    await createFake('Zed')
    await failReadsOf('matches')
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/fakes', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'fakes_fetch_failed' })
  })
})

describe('admin fake-liker runs', () => {
  it('lists runs newest-first, camelCased, with pagination', async () => {
    await insertRow('fake_liker_runs', {
      trigger: 'schedule', started_at: '2026-08-04T00:00:00.000Z', finished_at: '2026-08-04T00:01:00.000Z',
    })
    const r1 = await insertRow('fake_liker_runs', {
      trigger: 'manual', started_at: '2026-08-05T00:00:00.000Z', finished_at: '2026-08-05T00:01:00.000Z',
      likes_sent: 10, matches_created: 2, salams_sent: 2, errors: 0,
    })
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/runs?page=1', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ total: 2, page: 1, pageCount: 1 })
    expect(body.items[0]).toEqual({
      id: r1.id, trigger: 'manual', startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T00:01:00.000Z',
      likesSent: 10, matchesCreated: 2, salamsSent: 2, errors: 0,
    })
  })

  it('pages 20 per page', async () => {
    await sql`
      insert into fake_liker_runs (trigger, started_at, finished_at)
      select 'schedule', now() - (g || ' hours')::interval, now() from generate_series(1, 21) g`
    const body = (await app.inject({ method: 'GET', url: '/admin/fake-liker/runs?page=2', headers })).json()
    expect(body).toMatchObject({ total: 21, page: 2, pageCount: 2 })
    expect(body.items).toHaveLength(1)
  })

  it('500s when the runs fetch fails', async () => {
    await failReadsOf('fake_liker_runs')
    const res = await app.inject({ method: 'GET', url: '/admin/fake-liker/runs', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'runs_fetch_failed' })
  })
})
