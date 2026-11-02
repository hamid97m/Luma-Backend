import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, createMatch, insertRow } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('GET /admin/stats', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const stats = async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/stats' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the dashboard payload with distinctly filtered counts', async () => {
    // "today" buckets use UTC midnight; keep "old" rows well outside every window.
    const old = ago(60 * DAY)
    const man = await createUser({ gender: 'man', created_at: ago(0), last_active: ago(0) })
    const woman = await createUser({ gender: 'woman', created_at: ago(3 * DAY), last_active: ago(3 * DAY) })
    const nb = await createUser({ gender: 'nonbinary', created_at: old, last_active: old })
    await createUser({ gender: 'woman', created_at: old, last_active: ago(0), deleted_at: old }) // deleted
    await createUser({ created_at: old, last_active: old, banned_at: old })
    await createUser({ created_at: old, last_active: old, is_seed: true, telegram_id: -1 })

    const m1 = await createMatch(man.id, woman.id, { created_at: ago(0) })
    await createMatch(man.id, nb.id, { created_at: old })
    await insertRow('messages', { match_id: m1.id, sender_id: man.id, body: 'hi', created_at: ago(0) })
    await insertRow('messages', { match_id: m1.id, sender_id: woman.id, body: 'yo', created_at: old })
    await insertRow('messages', { match_id: m1.id, sender_id: man.id, body: 'q?', type: 'icebreaker', created_at: ago(0) })
    await insertRow('swipes', { swiper_id: man.id, swiped_id: woman.id, direction: 'like' })
    await insertRow('swipes', { swiper_id: woman.id, swiped_id: man.id, direction: 'like' })
    await insertRow('swipes', { swiper_id: nb.id, swiped_id: man.id, direction: 'pass' })
    await insertRow('swipes', { swiper_id: man.id, swiped_id: nb.id, direction: 'pass' })

    const body = await stats()

    expect(body.totals).toEqual({
      users: 5, matches: 2, messages: 2, swipes: 4,
      likeRate: 0.5, banned: 1, deleted: 1, seed: 1,
    })
    expect(body.today).toEqual({ newUsers: 1, matches: 1, messages: 1 })
    expect(body.week).toEqual({ newUsers: 2 })
    expect(body.dau).toBe(1) // the deleted user active today is excluded
    expect(body.wau).toBe(2)
    expect(body.genders).toEqual({ man: 3, woman: 1, nonbinary: 1 })
    expect(body.signupsPerDay).toHaveLength(30)
    expect(body.matchesPerDay).toHaveLength(30)
    expect(body.signupsPerDay[29].count).toBe(1)
    expect(body.signupsPerDay[29].date).toBe(new Date().toISOString().slice(0, 10))
    expect(body.signupsPerDay.reduce((s: number, d: any) => s + d.count, 0)).toBe(2)
    expect(body.matchesPerDay[29].count).toBe(1)
  })

  it('likeRate is 0 with no swipes', async () => {
    const body = await stats()
    expect(body.totals.likeRate).toBe(0)
    expect(body.totals.users).toBe(0)
  })

  it('returns 500 when a query fails', async () => {
    const res = await withTableBroken('swipes', () => app.inject({ method: 'GET', url: '/admin/stats', headers }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'stats_fetch_failed' })
  })

  it('includes premium stats', async () => {
    const u1 = await createUser({ premium_until: ago(-10 * DAY) })
    const u2 = await createUser({ premium_until: ago(1 * DAY) }) // expired
    const tx = (user_id: string, row: Record<string, unknown>) => insertRow('premium_transactions', {
      user_id, plan_title: 'Month', duration_days: 30, ...row,
    })
    await tx(u1.id, { status: 'paid', source: 'purchase', price_stars: 100, paid_at: ago(2 * DAY) })
    await tx(u1.id, { status: 'paid', source: 'purchase', price_stars: 100, paid_at: ago(0) })
    await tx(u2.id, { status: 'paid', source: 'purchase', price_stars: 50, paid_at: ago(0) })
    await tx(u2.id, { status: 'paid', source: 'referral', price_stars: 0, paid_at: ago(0) })
    await tx(u2.id, { status: 'pending_payment', source: 'purchase', price_stars: 999 })

    const body = await stats()

    expect(body.premium.activeUsers).toBe(1)
    expect(body.premium.revenueStars).toBe(250)
    const perDay = body.premium.newPremiumPerDay
    expect(perDay[29]).toEqual({ date: new Date().toISOString().slice(0, 10), count: 1 }) // u2 first paid today
    expect(perDay[27].count).toBe(1) // u1's first payment, counted once
    expect(perDay.reduce((s: number, d: any) => s + d.count, 0)).toBe(2)
  })
})
