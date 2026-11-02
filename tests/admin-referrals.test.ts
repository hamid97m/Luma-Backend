import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({}))

import { buildApp } from '../src/server.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('admin referrals', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    // The admin preHandler only verifies the JWT (no admins-table lookup).
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the referral config', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
  })

  it('500 config_fetch_failed when the config row is missing', async () => {
    await sql`delete from referral_config`
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('persists and echoes the toggle on PUT', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/referrals/config', headers, payload: { enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true })
    expect((await sql`select enabled from referral_config`)[0].enabled).toBe(true)
  })

  it('rejects a non-boolean enabled value', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/referrals/config', headers, payload: { enabled: 'yes' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_enabled' })
  })

  it('aggregates stats and top referrers', async () => {
    const alice = await createUser({ name: 'Alice' })
    const bob = await createUser({ name: 'Bob' })
    const carol = await createUser({ name: 'Carol' })
    const dave = await createUser({ name: 'Dave' }) // only unqualified referrals → not in top
    const plan: [Record<string, any>, number, number][] = [[alice, 3, 1], [bob, 2, 1], [carol, 1, 0], [dave, 0, 2]]
    for (const [referrer, qualified, unqualified] of plan) {
      for (let i = 0; i < qualified + unqualified; i++) {
        const u = await createUser({ referred_by: referrer.id })
        await sql`insert into referrals (referrer_id, referred_id, qualified_at)
          values (${referrer.id}, ${u.id}, ${i < qualified ? new Date().toISOString() : null})`
      }
    }
    for (const [referrer, milestone] of [[alice, 1], [alice, 3], [bob, 1], [carol, 1], [dave, 1]] as const) {
      await sql`insert into referral_rewards (referrer_id, milestone) values (${referrer.id}, ${milestone})`
    }

    const res = await app.inject({ method: 'GET', url: '/admin/referrals/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      total: 10,
      qualified: 6,
      rewardsGranted: 5,
      topReferrers: [
        { userId: alice.id, name: 'Alice', qualifiedCount: 3 },
        { userId: bob.id, name: 'Bob', qualifiedCount: 2 },
        { userId: carol.id, name: 'Carol', qualifiedCount: 1 },
      ],
    })
  })

  it('returns zeros and no top referrers on an empty program', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/referrals/stats', headers })
    expect(res.json()).toEqual({ total: 0, qualified: 0, rewardsGranted: 0, topReferrers: [] })
  })

  it('500 stats_fetch_failed when a stats query errors', async () => {
    await sql`alter table referral_rewards rename to referral_rewards_x`
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/referrals/stats', headers })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
    } finally {
      await sql`alter table referral_rewards_x rename to referral_rewards`
    }
  })
})
