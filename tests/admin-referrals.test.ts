import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin referrals', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the referral config', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'referral_config' ? chainable({ data: { enabled: false }, error: null }) : chainable({ data: null }))
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
  })

  it('persists and echoes the toggle on PUT', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_config') {
        return { update: (p: any) => { updates.push(p); return chainable({ data: { enabled: true }, error: null }) } } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'PUT', url: '/admin/referrals/config', headers, payload: { enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true })
    expect(updates[0]).toMatchObject({ enabled: true })
  })

  it('rejects a non-boolean enabled value', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/referrals/config', headers, payload: { enabled: 'yes' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_enabled' })
  })

  it('aggregates stats and top referrers from mocked rows', async () => {
    const qualifiedRows = [
      { referrer_id: 'u1' }, { referrer_id: 'u1' }, { referrer_id: 'u1' },
      { referrer_id: 'u2' }, { referrer_id: 'u2' },
      { referrer_id: 'u3' },
    ]
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referrals') {
        return {
          select: (_col: string, opts?: any) => {
            if (opts?.head) return chainable({ count: 10, error: null })
            return chainable({ data: qualifiedRows, error: null })
          },
        } as any
      }
      if (table === 'referral_rewards') {
        return chainable({ count: 5, error: null })
      }
      if (table === 'users') {
        return chainable({
          data: [
            { id: 'u1', name: 'Alice' },
            { id: 'u2', name: 'Bob' },
            { id: 'u3', name: 'Carol' },
          ],
          error: null,
        })
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      total: 10,
      qualified: 6,
      rewardsGranted: 5,
      topReferrers: [
        { userId: 'u1', name: 'Alice', qualifiedCount: 3 },
        { userId: 'u2', name: 'Bob', qualifiedCount: 2 },
        { userId: 'u3', name: 'Carol', qualifiedCount: 1 },
      ],
    })
  })
})
