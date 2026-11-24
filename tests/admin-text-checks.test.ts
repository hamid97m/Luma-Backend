import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/server.js'
import { resetDb, createUser, insertRow } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('admin text checks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const check = (user_id: string, row: Record<string, unknown>) =>
    insertRow('profile_text_checks', { user_id, field: 'bio', text: 'x', source: 'ai', ...row })

  it('requires an admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/text-checks' })).statusCode).toBe(401)
  })

  it('summarizes checks', async () => {
    const u = await createUser()
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    await check(u.id, { approved: false, reason: 'contact_info', source: 'regex' })
    await check(u.id, { field: 'name', approved: false, reason: 'fake_name', prompt_tokens: 1000, completion_tokens: 20, created_at: old })
    await check(u.id, { approved: true, prompt_tokens: 4000, completion_tokens: 60, created_at: old })

    const res = await app.inject({ method: 'GET', url: '/admin/text-checks/stats', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      total: 3, approved: 1, rejected: 2,
      last24h: { total: 1, rejected: 1 }, last7d: { total: 3, rejected: 2 },
      byReason: { contact_info: 1, fake_name: 1 }, byField: { bio: 1, name: 1 },
      promptTokens: 5000, completionTokens: 80,
    })
    expect(body.estimatedCostUsd).toBeCloseTo(5000 * 0.3e-6 + 80 * 1.2e-6)
  })

  it('reports zeros on an empty table', async () => {
    const body = (await app.inject({ method: 'GET', url: '/admin/text-checks/stats', headers })).json()
    expect(body).toMatchObject({ total: 0, approved: 0, rejected: 0, byReason: {}, byField: {}, estimatedCostUsd: 0 })
  })

  it('lists checks newest first with filters', async () => {
    const ali = await createUser({ name: 'Ali', banned_at: '2026-08-01T00:00:00Z' })
    const sara = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
    const c1 = await check(ali.id, { field: 'name', text: 'Admin', approved: false, reason: 'fake_name', created_at: '2026-08-02T00:00:00Z' })
    await check(sara.id, { text: 'hi', approved: true, created_at: '2026-08-03T00:00:00Z' })

    const all = (await app.inject({ method: 'GET', url: '/admin/text-checks', headers })).json()
    expect(all).toMatchObject({ total: 2, page: 1, pageCount: 1 })
    expect(all.items.map((i: any) => i.text)).toEqual(['hi', 'Admin'])
    expect(all.items[1]).toEqual({
      id: c1.id,
      user: { id: ali.id, name: 'Ali', gender: 'man', bannedAt: expect.any(String), deletedAt: null },
      field: 'name', text: 'Admin', approved: false, reason: 'fake_name', source: 'ai',
      createdAt: expect.any(String),
    })

    const rejected = (await app.inject({ method: 'GET', url: '/admin/text-checks?verdict=rejected', headers })).json()
    expect(rejected.items.map((i: any) => i.id)).toEqual([c1.id])
    const byField = (await app.inject({ method: 'GET', url: '/admin/text-checks?field=bio', headers })).json()
    expect(byField.items.map((i: any) => i.text)).toEqual(['hi'])
    const byUser = (await app.inject({ method: 'GET', url: `/admin/text-checks?userId=${sara.id}`, headers })).json()
    expect(byUser.total).toBe(1)
    expect((await app.inject({ method: 'GET', url: '/admin/text-checks?userId=nope', headers })).statusCode).toBe(400)
  })

  it('paginates by 30', async () => {
    const u = await createUser()
    for (let i = 0; i < 31; i++) await check(u.id, { text: `t${i}`, approved: true })
    const p2 = (await app.inject({ method: 'GET', url: '/admin/text-checks?page=2', headers })).json()
    expect(p2).toMatchObject({ total: 31, page: 2, pageCount: 2 })
    expect(p2.items).toHaveLength(1)
  })
})
