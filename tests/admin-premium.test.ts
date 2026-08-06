import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const PLAN_ROW = {
  id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100,
  discount_percent: null, discount_ends_at: null, duration_days: 30, is_active: true, sort_order: 0,
  created_at: '2026-08-05T00:00:00Z',
}
const PLAN_JSON = {
  id: 'p1', title: '1 Month', description: 'Best start', priceStars: 100,
  discountPercent: null, discountEndsAt: null, durationDays: 30, isActive: true, sortOrder: 0,
  createdAt: '2026-08-05T00:00:00Z',
}

describe('admin premium', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the premium config', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'premium_config' ? chainable({ data: { premium_enabled: true }, error: null }) : chainable({ data: null }))
    const res = await app.inject({ method: 'GET', url: '/admin/premium/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: true })
  })

  it('updates the toggle', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') {
        return { update: (p: any) => { updates.push(p); return chainable({ data: { premium_enabled: true }, error: null }) } } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ premiumEnabled: true })
    expect(updates[0]).toMatchObject({ premium_enabled: true })
  })

  it('rejects a non-boolean toggle', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/premium/config', headers, payload: { premiumEnabled: 'yes' } })
    expect(res.statusCode).toBe(400)
  })

  it('lists all plans including inactive', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'premium_plans' ? chainable({ data: [PLAN_ROW], error: null }) : chainable({ data: null }))
    const res = await app.inject({ method: 'GET', url: '/admin/premium/plans', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ plans: [PLAN_JSON] })
  })

  it('creates a plan', async () => {
    const inserts: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return { insert: (p: any) => { inserts.push(p); return chainable({ data: PLAN_ROW, error: null }) } } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: '1 Month', description: 'Best start', priceStars: 100, durationDays: 30 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual(PLAN_JSON)
    expect(inserts[0]).toMatchObject({ title: '1 Month', price_stars: 100, duration_days: 30 })
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
    const inserts: any[] = []
    const endsAt = '2026-09-01T00:00:00.000Z'
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return {
          insert: (p: any) => {
            inserts.push(p)
            return chainable({ data: { ...PLAN_ROW, discount_percent: 25, discount_ends_at: endsAt }, error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'POST', url: '/admin/premium/plans', headers,
      payload: { title: '1 Month', priceStars: 100, durationDays: 30, discountPercent: 25, discountEndsAt: endsAt },
    })
    expect(res.statusCode).toBe(201)
    expect(inserts[0]).toMatchObject({ discount_percent: 25, discount_ends_at: endsAt })
    expect(res.json()).toMatchObject({ discountPercent: 25, discountEndsAt: endsAt })
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
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return {
          update: (p: any) => {
            updates.push(p)
            return { eq: () => ({ select: () => ({ maybeSingle: () => chainable({ data: { ...PLAN_ROW, discount_percent: 25, discount_ends_at: endsAt }, error: null }) }) }) }
          },
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: { discountEndsAt: endsAt },
    })
    expect(res.statusCode).toBe(200)
    expect(updates[0]).toMatchObject({ discount_ends_at: endsAt })
    expect(updates[0]).not.toHaveProperty('discount_percent')
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
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return {
          update: (p: any) => {
            updates.push(p)
            return { eq: () => ({ select: () => ({ maybeSingle: () => chainable({ data: { ...PLAN_ROW, discount_ends_at: null }, error: null }) }) }) }
          },
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: { discountEndsAt: null },
    })
    expect(res.statusCode).toBe(200)
    expect(updates[0]).toMatchObject({ discount_ends_at: null })
  })

  it('409s deleting a plan that has transactions', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') return chainable({ count: 3, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'DELETE', url: '/admin/premium/plans/p1', headers })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'plan_has_transactions' })
  })

  it('deletes an unused plan', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') return chainable({ count: 0, error: null })
      if (table === 'premium_plans') return chainable({ data: { id: 'p1' }, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'DELETE', url: '/admin/premium/plans/p1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('PUT partial update — description only', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return {
          update: (p: any) => { updates.push(p); return chainable({ data: { ...PLAN_ROW, description: 'Updated desc' }, error: null }) },
          eq: () => ({ select: () => ({ maybeSingle: () => chainable({ data: { ...PLAN_ROW, description: 'Updated desc' }, error: null }) }) })
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/p1', headers,
      payload: { description: 'Updated desc' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ description: 'Updated desc' })
    expect(updates[0]).toMatchObject({ description: 'Updated desc' })
    expect(updates[0]).toHaveProperty('updated_at')
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

  it('PUT with unknown id → 404 plan_not_found', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_plans') {
        return {
          update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => chainable({ data: null, error: null }) }) }) })
        } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({
      method: 'PUT', url: '/admin/premium/plans/unknown', headers,
      payload: { description: 'New' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'plan_not_found' })
  })

  it('DELETE with unknown id → 404 plan_not_found', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') return chainable({ count: 0, error: null })
      if (table === 'premium_plans') return chainable({ data: null, error: null })
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'DELETE', url: '/admin/premium/plans/unknown', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'plan_not_found' })
  })
})

describe('admin premium transactions + grant/revoke', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('lists transactions with user info and pagination', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') {
        return chainable({
          data: [{
            id: 't1', plan_title: '1 Month', price_stars: 100, duration_days: 30,
            status: 'paid', source: 'purchase', created_at: '2026-08-05T00:00:00Z', paid_at: '2026-08-05T00:01:00Z',
            user: { name: 'Ali', username: 'ali' },
          }],
          count: 1, error: null,
        })
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'GET', url: '/admin/premium/transactions?page=1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        id: 't1', userName: 'Ali', userUsername: 'ali', planTitle: '1 Month',
        priceStars: 100, durationDays: 30, status: 'paid', source: 'purchase',
        createdAt: '2026-08-05T00:00:00Z', paidAt: '2026-08-05T00:01:00Z',
      }],
      total: 1, page: 1, pageCount: 1,
    })
  })

  it('grants days: extends premium_until and records an admin_grant tx', async () => {
    const userUpdates: any[] = []
    const txInserts: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => ({ data: { id: 'u1', premium_until: null } }) }) }),
          update: (p: any) => { userUpdates.push(p); return chainable({ error: null }) },
        } as any
      }
      if (table === 'premium_transactions') {
        return { insert: (p: any) => { txInserts.push(p); return chainable({ error: null }) } } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/premium/grant', headers, payload: { days: 30 } })
    expect(res.statusCode).toBe(200)
    expect(new Date(res.json().premiumUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000)
    expect(userUpdates[0].premium_until).toBe(res.json().premiumUntil)
    expect(txInserts[0]).toMatchObject({
      user_id: 'u1', plan_id: null, plan_title: 'Admin grant', price_stars: 0,
      duration_days: 30, status: 'paid', source: 'admin_grant',
    })
  })

  it('rejects an invalid grant days value', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/premium/grant', headers, payload: { days: 0 } })
    expect(res.statusCode).toBe(400)
  })

  it('404s granting to an unknown user', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return { select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }) } as any
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/premium/grant', headers, payload: { days: 7 } })
    expect(res.statusCode).toBe(404)
  })

  it('revoke clears premium_until', async () => {
    const userUpdates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return { update: (p: any) => { userUpdates.push(p); return { eq: () => ({ select: () => ({ maybeSingle: () => ({ data: { id: 'u1' } }) }) }) } } } as any
      }
      return chainable({ data: null })
    })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/premium/revoke', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(userUpdates[0]).toMatchObject({ premium_until: null })
  })
})
