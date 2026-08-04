import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('GET /admin/stats', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/stats' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the dashboard payload shape', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ count: 5, data: [{ created_at: new Date().toISOString() }], error: null })
    )

    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.totals).toEqual({
      users: 5, matches: 5, messages: 5, swipes: 5,
      likeRate: 1, banned: 5, deleted: 5, seed: 5,
    })
    expect(body.today).toEqual({ newUsers: 5, matches: 5, messages: 5 })
    expect(body.week).toEqual({ newUsers: 5 })
    expect(body.dau).toBe(5)
    expect(body.wau).toBe(5)
    expect(body.genders).toEqual({ man: 5, woman: 5, nonbinary: 5 })
    expect(body.signupsPerDay).toHaveLength(30)
    expect(body.matchesPerDay).toHaveLength(30)
    // the single mocked row (created now) lands in today's bucket — the last entry
    expect(body.signupsPerDay[29].count).toBe(1)
    expect(body.signupsPerDay[29].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns 500 when a query fails', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ count: null, data: null, error: { message: 'boom' } }))
    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })

  it('issues distinctly filtered queries (dau/wau windows, gender split, like rate)', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ count: 5, data: [{ created_at: new Date().toISOString() }], error: null }, log)
    )
    await app.inject({ method: 'GET', url: '/admin/stats', headers })
    const genderEqs = log.filter((c) => c.method === 'eq' && c.args[0] === 'gender').map((c) => c.args[1])
    expect(genderEqs).toEqual(expect.arrayContaining(['man', 'woman', 'nonbinary']))
    const lastActiveCutoffs = log.filter((c) => c.method === 'gte' && c.args[0] === 'last_active').map((c) => c.args[1])
    expect(new Set(lastActiveCutoffs).size).toBe(2)
    expect(log.some((c) => c.method === 'eq' && c.args[0] === 'direction' && c.args[1] === 'like')).toBe(true)
  })
})
