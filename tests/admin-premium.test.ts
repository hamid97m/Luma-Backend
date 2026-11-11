import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/bot.js', () => ({}))

import { buildApp } from '../src/server.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { failOn, failReadsOf, clearFailures } from './helpers/bot-support.js'

const PLAN_ROW = {
  title: '1 Month', description: 'Best start', price_stars: 100,
  discount_percent: null, discount_ends_at: null, duration_days: 30, is_active: true, sort_order: 0,
  created_at: '2026-08-05T00:00:00.000Z',
}
const PLAN_JSON = {
  title: '1 Month', description: 'Best start', translations: {}, priceStars: 100,
  discountPercent: null, discountEndsAt: null, durationDays: 30, isActive: true, sortOrder: 0,
  createdAt: '2026-08-05T00:00:00.000Z',
}
const createPlan = (extra: Record<string, unknown> = {}) => insertRow('premium_plans', { ...PLAN_ROW, ...extra })
const MISSING = '00000000-0000-0000-0000-000000000000'

describe('admin premium', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    headers = adminHeaders()
  })
  afterEach(clearFailures)

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config' })
    expect(res.statusCode).toBe(401)
  })

  it('admin routes get the larger 600/min bucket, not the 120/min user one', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-ratelimit-limit']).toBe('600')
  })

  it('reads the premium config', async () => {
    await sql`update premium_config set premium_enabled = true`
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: true, tomanPerStar: 3000 })
  })

  it('500 config_fetch_failed when the config row is missing', async () => {
    await sql`delete from premium_config`
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('updates the toggle', async () => {
    await sql`update premium_config set toman_per_star = 3100, updated_at = '2020-01-01T00:00:00Z'`
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: true, tomanPerStar: 3100 })
    const [row] = await sql`select updated_at from premium_config`
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('rejects a non-boolean toggle', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: 'yes' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_premium_enabled' })
  })

  it('updates tomanPerStar alone, leaving premiumEnabled untouched', async () => {
    await sql`update premium_config set premium_enabled = true`
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { tomanPerStar: 3500 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: true, tomanPerStar: 3500 })
  })

  it('updates premiumEnabled and tomanPerStar together', async () => {
    await sql`update premium_config set premium_enabled = true`
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: false, tomanPerStar: 4000 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: false, tomanPerStar: 4000 })
    const [row] = await sql`select premium_enabled, toman_per_star from premium_config`
    expect(row).toEqual({ premium_enabled: false, toman_per_star: 4000 })
  })

  it('500 config_update_failed when the update fails', async () => {
    await failOn('premium_config', 'update')
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: true } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_update_failed' })
  })

  it('rejects an invalid tomanPerStar', async () => {
    for (const tomanPerStar of [0, -100, '3000', 10.5]) {
      const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { tomanPerStar } })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_toman_per_star' })
    }
  })

  it('rejects a PUT with neither field set', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_update' })
  })

  it('lists all plans including inactive, by sort_order then created_at', async () => {
    const p = await createPlan()
    const inactive = await createPlan({ title: 'Old', is_active: false, sort_order: 0, created_at: '2026-08-06T00:00:00.000Z' })
    const first = await createPlan({ title: 'Top', sort_order: -1 })
    const res = await app.inject({ method: 'GET', url: '/admin/premium/plans', headers })
    expect(res.statusCode).toBe(200)
    const { plans } = res.json()
    expect(plans.map((x: any) => x.id)).toEqual([first.id, p.id, inactive.id])
    expect(plans[1]).toEqual({ id: p.id, ...PLAN_JSON })
  })

  it('500 plans_fetch_failed when the list query fails', async () => {
    await failReadsOf('premium_plans')
    const res = await app.inject({ method: 'GET', url: '/admin/premium/plans', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'plans_fetch_failed' })
  })

  it('creates a plan', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: '1 Month', description: 'Best start', priceStars: 100, durationDays: 30 },
    })
    expect(res.statusCode).toBe(201)
    const [row] = await sql`select id, created_at from premium_plans`
    expect(res.json()).toEqual({ ...PLAN_JSON, id: row.id, createdAt: row.created_at })
  })

  it('500 plan_create_failed when the insert fails', async () => {
    await failOn('premium_plans', 'insert')
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers, payload: { title: 'X', priceStars: 1, durationDays: 1 },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'plan_create_failed' })
  })

  it('validates plan input', async () => {
    for (const payload of [
      { title: '', priceStars: 100, durationDays: 30 },
      { title: 'X', priceStars: 0, durationDays: 30 },
      { title: 'X', priceStars: 100, durationDays: 0 },
      { title: 'X', priceStars: 100, durationDays: 30, discountPercent: 95 },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/admin/premium/plans', headers, payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('POST with a title over 32 chars → 400 invalid_title', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'X'.repeat(33), priceStars: 100, durationDays: 30 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_title' })
  })

  it('POST with a description over 255 chars → 400 invalid_description', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'X', description: 'X'.repeat(256), priceStars: 100, durationDays: 30 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_description' })
  })

  it('creates a plan with a discount percent and an ends-at deadline', async () => {
    const endsAt = '2026-09-01T00:00:00.000Z'
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: '1 Month', priceStars: 100, durationDays: 30, discountPercent: 25, discountEndsAt: endsAt },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ discountPercent: 25, discountEndsAt: endsAt })
    const [row] = await sql`select discount_percent, discount_ends_at from premium_plans`
    expect(row).toEqual({ discount_percent: 25, discount_ends_at: endsAt })
  })

  it('POST with an unparseable discountEndsAt → 400 invalid_discount_ends_at', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'X', priceStars: 100, durationDays: 30, discountPercent: 25, discountEndsAt: 'not-a-date' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_discount_ends_at' })
  })

  it('POST with discountEndsAt but discountPercent omitted → 400 discount_ends_requires_percent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'X', priceStars: 100, durationDays: 30, discountEndsAt: '2026-09-01T00:00:00.000Z' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'discount_ends_requires_percent' })
  })

  it('POST with discountEndsAt and discountPercent explicitly null → 400 discount_ends_requires_percent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'X', priceStars: 100, durationDays: 30, discountPercent: null, discountEndsAt: '2026-09-01T00:00:00.000Z' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'discount_ends_requires_percent' })
  })

  it('PUT setting discountEndsAt with percent omitted assumes the existing percent (allowed)', async () => {
    const endsAt = '2026-09-01T00:00:00.000Z'
    const p = await createPlan({ discount_percent: 25 })
    const res = await app.inject({
      method: 'PUT', url: `/admin/premium/plans/${p.id}`, headers,
      payload: { discountEndsAt: endsAt },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ discountPercent: 25, discountEndsAt: endsAt })
  })

  it('PUT setting discountEndsAt while explicitly nulling the percent → 400 discount_ends_requires_percent', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: { discountPercent: null, discountEndsAt: '2026-09-01T00:00:00.000Z' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'discount_ends_requires_percent' })
  })

  it('PUT clearing discountEndsAt to null is valid', async () => {
    const p = await createPlan({ discount_percent: 25, discount_ends_at: '2026-09-01T00:00:00.000Z' })
    const res = await app.inject({
      method: 'PUT', url: `/admin/premium/plans/${p.id}`, headers,
      payload: { discountEndsAt: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ discountPercent: 25, discountEndsAt: null })
  })

  it('409s deleting a plan that has transactions', async () => {
    const p = await createPlan()
    const u = await createUser()
    await insertRow('premium_transactions', { user_id: u.id, plan_id: p.id, plan_title: 'x', price_stars: 1, duration_days: 1 })
    const res = await app.inject({ method: 'DELETE', url: `/admin/premium/plans/${p.id}`, headers })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'plan_has_transactions' })
    expect(await sql`select id from premium_plans`).toHaveLength(1)
  })

  it('deletes an unused plan', async () => {
    const p = await createPlan()
    const res = await app.inject({ method: 'DELETE', url: `/admin/premium/plans/${p.id}`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await sql`select id from premium_plans`).toHaveLength(0)
  })

  it('PUT partial update — description only', async () => {
    const p = await createPlan({ updated_at: '2020-01-01T00:00:00Z' })
    const res = await app.inject({
      method: 'PUT', url: `/admin/premium/plans/${p.id}`, headers,
      payload: { description: 'Updated desc' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ...PLAN_JSON, id: p.id, description: 'Updated desc' })
    const [row] = await sql`select updated_at from premium_plans`
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('500 plan_update_failed when the update fails', async () => {
    const p = await createPlan()
    await failOn('premium_plans', 'update')
    const res = await app.inject({ method: 'PUT', url: `/admin/premium/plans/${p.id}`, headers, payload: { description: 'x' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'plan_update_failed' })
  })

  it('PUT with empty body → 400 empty_update', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_update' })
  })

  it('PUT with non-integer priceStars → 400 invalid_price_stars', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: { priceStars: 10.5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_price_stars' })
  })

  it('PUT with unknown or malformed id → 404 plan_not_found', async () => {
    for (const id of [MISSING, 'unknown']) {
      const res = await app.inject({
        method: 'PUT', url: `/admin/premium/plans/${id}`, headers,
        payload: { description: 'New' },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'plan_not_found' })
    }
  })

  it('DELETE with unknown or malformed id → 404 plan_not_found', async () => {
    for (const id of [MISSING, 'unknown']) {
      const res = await app.inject({ method: 'DELETE', url: `/admin/premium/plans/${id}`, headers })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'plan_not_found' })
    }
  })

  it('stores and returns plan translations (as a jsonb object)', async () => {
    const translations = { en: { title: '1 Month', description: 'Best start' } }
    const res = await app.inject({ method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: 'یک ماهه', description: '', priceStars: 100, durationDays: 30, translations } })
    expect(res.statusCode).toBe(201)
    expect(res.json().translations).toEqual(translations)
    const [row] = await sql`select translations, jsonb_typeof(translations) as t from premium_plans`
    expect(row).toEqual({ translations, t: 'object' })

    const upd = await app.inject({ method: 'PUT', url: `/admin/premium/plans/${res.json().id}`, headers,
      payload: { translations: { ar: { title: 'شهر' } } } })
    expect(upd.json().translations).toEqual({ ar: { title: 'شهر' } })
  })

  it('rejects malformed translations', async () => {
    for (const translations of [{ de: { title: 'x' } }, 'en', ['en'], { en: 'x' }, { en: { title: 'X'.repeat(33) } }]) {
      const res = await app.inject({ method: 'POST', url: '/admin/premium/plans', headers,
        payload: { title: 'x', priceStars: 1, durationDays: 1, translations } })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_translations' })
    }
  })
})

describe('admin premium transactions + grant/revoke', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    headers = adminHeaders()
  })
  afterEach(clearFailures)

  const tx = (user_id: string, extra: Record<string, unknown> = {}) => insertRow('premium_transactions', {
    user_id, plan_title: '1 Month', price_stars: 100, duration_days: 30, status: 'paid', source: 'purchase',
    created_at: '2026-08-05T00:00:00.000Z', paid_at: '2026-08-05T00:01:00.000Z', ...extra,
  })

  it('lists transactions with user info and pagination', async () => {
    const ali = await createUser({ name: 'Ali', username: 'ali' })
    const t = await tx(ali.id)
    const res = await app.inject({ method: 'GET', url: '/admin/premium/transactions?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        id: t.id, userName: 'Ali', userUsername: 'ali', planTitle: '1 Month',
        priceStars: 100, durationDays: 30, status: 'paid', source: 'purchase',
        createdAt: '2026-08-05T00:00:00.000Z', paidAt: '2026-08-05T00:01:00.000Z',
        provider: 'stars', priceToman: null, tonpaysStatus: null,
      }],
      total: 1, page: 1, pageCount: 1,
    })
  })

  it('pages 25 per page newest first', async () => {
    const u = await createUser()
    for (let i = 0; i < 26; i++) await tx(u.id, { created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() })
    const body = (await app.inject({ method: 'GET', url: '/admin/premium/transactions?page=2', headers })).json()
    expect(body).toMatchObject({ total: 26, page: 2, pageCount: 2 })
    expect(body.items).toHaveLength(1)
    expect(body.items[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('lists a tonpays transaction with priceToman and tonpaysStatus', async () => {
    const sara = await createUser({ name: 'Sara' })
    await tx(sara.id, { price_stars: 0, provider: 'tonpays', price_toman: 150000, tonpays_status: 'verified' })
    const res = await app.inject({ method: 'GET', url: '/admin/premium/transactions?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({
      userName: 'Sara', userUsername: null, provider: 'tonpays', priceToman: 150000, tonpaysStatus: 'verified',
    })
  })

  it('filters transactions by provider, status and source', async () => {
    const u = await createUser()
    const stars = await tx(u.id)
    const ton = await tx(u.id, { provider: 'tonpays' })
    const grant = await tx(u.id, { source: 'admin_grant' })
    const pending = await tx(u.id, { status: 'pending_payment' })
    const ids = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/admin/premium/transactions?${q}`, headers })).json().items.map((i: any) => i.id).sort()
    expect(await ids('provider=tonpays')).toEqual([ton.id])
    expect(await ids('source=admin_grant')).toEqual([grant.id])
    expect(await ids('status=pending_payment')).toEqual([pending.id])
    expect(await ids('provider=stars&source=purchase&status=paid')).toEqual([stars.id])
    const tonpaysTotal = (await app.inject({ method: 'GET', url: '/admin/premium/transactions?provider=tonpays', headers })).json().total
    expect(tonpaysTotal).toBe(1)
  })

  it('ignores an unknown provider filter value', async () => {
    const u = await createUser()
    await tx(u.id)
    await tx(u.id, { provider: 'tonpays' })
    const res = await app.inject({ method: 'GET', url: '/admin/premium/transactions?provider=bogus', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(2)
  })

  it('500 transactions_fetch_failed when the query fails', async () => {
    await failReadsOf('premium_transactions')
    const res = await app.inject({ method: 'GET', url: '/admin/premium/transactions', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'transactions_fetch_failed' })
  })

  it('grants days: extends premium_until and records an admin_grant tx', async () => {
    const u = await createUser()
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/premium/grant`, headers, payload: { days: 30 } })
    expect(res.statusCode).toBe(200)
    expect(new Date(res.json().premiumUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000)
    const [row] = await sql`select premium_until from users where id = ${u.id}`
    expect(row.premium_until).toBe(res.json().premiumUntil)
    const txs = await sql`select user_id, plan_id, plan_title, price_stars, duration_days, status, source, paid_at from premium_transactions`
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      user_id: u.id, plan_id: null, plan_title: 'Admin grant', price_stars: 0,
      duration_days: 30, status: 'paid', source: 'admin_grant',
    })
    expect(txs[0].paid_at).not.toBeNull()
  })

  it('grant extends from an existing future premium_until', async () => {
    const until = new Date(Date.now() + 10 * 86400000).toISOString()
    const u = await createUser({ premium_until: until })
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/premium/grant`, headers, payload: { days: 5 } })
    expect(res.json().premiumUntil).toBe(new Date(Date.parse(until) + 5 * 86400000).toISOString())
  })

  it('grant still succeeds when recording the tx fails (only logged)', async () => {
    const u = await createUser()
    await failOn('premium_transactions', 'insert')
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/premium/grant`, headers, payload: { days: 7 } })
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select premium_until from users where id = ${u.id}`
    expect(row.premium_until).toBe(res.json().premiumUntil)
  })

  it('500 grant_failed when the user update fails', async () => {
    const u = await createUser()
    await failOn('users', 'update')
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/premium/grant`, headers, payload: { days: 7 } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'grant_failed' })
    expect(await sql`select id from premium_transactions`).toHaveLength(0)
  })

  it('rejects an invalid grant days value', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/premium/grant', headers, payload: { days: 0 } })
    expect(res.statusCode).toBe(400)
  })

  it('404s granting to an unknown or malformed user id', async () => {
    for (const id of [MISSING, 'u1']) {
      const res = await app.inject({ method: 'POST', url: `/admin/users/${id}/premium/grant`, headers, payload: { days: 7 } })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'user_not_found' })
    }
  })

  it('revoke clears premium_until', async () => {
    const u = await createUser({ premium_until: new Date(Date.now() + 86400000).toISOString() })
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/premium/revoke`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const [row] = await sql`select premium_until from users where id = ${u.id}`
    expect(row.premium_until).toBeNull()
  })

  it('revoke 404s an unknown or malformed user id', async () => {
    for (const id of [MISSING, 'u1']) {
      const res = await app.inject({ method: 'POST', url: `/admin/users/${id}/premium/revoke`, headers })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'user_not_found' })
    }
  })
})
