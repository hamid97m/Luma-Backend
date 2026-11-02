import { describe, it, expect, vi, beforeEach } from 'vitest'

// Storage stays on supabase for now; the DB queries hit the real Postgres.
vi.mock('../src/db.js', async (orig) => ({
  ...(await orig<typeof import('../src/db.js')>()),
  db: { storage: { from: vi.fn() } },
}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { resetDb, createUser, insertRow } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

describe('admin photo checks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const check = (user_id: string, row: Record<string, unknown>) =>
    insertRow('photo_ai_checks', { photo_id: crypto.randomUUID(), user_id, ...row })

  it('summarizes checks and prices the tokens at the peak rate', async () => {
    const u = await createUser()
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    await check(u.id, { approved: false, reason: 'no_face', prompt_tokens: 1000, completion_tokens: 20 })
    await check(u.id, { approved: false, reason: 'no_face', prompt_tokens: 1000, completion_tokens: 20, created_at: old })
    await check(u.id, { approved: true, prompt_tokens: 4000, completion_tokens: 60, created_at: old })

    const res = await app.inject({ method: 'GET', url: '/admin/photo-checks/stats', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      total: 3, approved: 1, rejected: 2,
      last24h: { total: 1, rejected: 1 }, last7d: { total: 3, rejected: 2 },
      byReason: { no_face: 2 }, promptTokens: 6000, completionTokens: 100,
    })
    expect(body.estimatedCostUsd).toBeCloseTo(6000 * 0.3e-6 + 100 * 1.2e-6)
  })

  it('reports zeros on an empty table', async () => {
    const body = (await app.inject({ method: 'GET', url: '/admin/photo-checks/stats', headers })).json()
    expect(body).toMatchObject({ total: 0, approved: 0, rejected: 0, byReason: {}, estimatedCostUsd: 0 })
  })

  it('500s when the stats view fails', async () => {
    // withTableBroken renames any relation, views included.
    const res = await withTableBroken('photo_ai_check_stats', () =>
      app.inject({ method: 'GET', url: '/admin/photo-checks/stats', headers }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photo_checks_fetch_failed' })
  })

  it('lists rejected checks with a signed evidence URL and approved ones with the public URL', async () => {
    const ali = await createUser({ name: 'Ali', paused_at: '2026-08-01T00:00:00Z' })
    const reza = await createUser({ name: 'Reza' })
    const p1 = await check(ali.id, {
      approved: false, reason: 'nudity', photo_url: 'https://pub/u1/p1', evidence_path: 'u1/p1',
      created_at: '2026-08-02T00:00:00Z',
    })
    await check(reza.id, { approved: true, photo_url: 'https://pub/u2/p2', created_at: '2026-08-01T00:00:00Z' })
    const createSignedUrls = vi.fn().mockResolvedValue({ data: [{ path: 'u1/p1', signedUrl: 'https://signed/u1/p1' }] })
    vi.mocked(db.storage.from).mockReturnValue({ createSignedUrls } as any)

    const rejected = (await app.inject({ method: 'GET', url: '/admin/photo-checks?verdict=rejected&page=1', headers })).json()
    expect(db.storage.from).toHaveBeenCalledWith('photo-ai-evidence')
    expect(createSignedUrls).toHaveBeenCalledWith(['u1/p1'], 3600)
    expect(rejected.total).toBe(1)
    expect(rejected.items).toEqual([{
      photoId: p1.photo_id,
      user: { id: ali.id, name: 'Ali', gender: 'man', pausedAt: '2026-08-01T00:00:00.000Z', bannedAt: null, deletedAt: null },
      approved: false, reason: 'nudity', createdAt: '2026-08-02T00:00:00.000Z', imageUrl: 'https://signed/u1/p1',
    }])

    const all = (await app.inject({ method: 'GET', url: '/admin/photo-checks', headers })).json()
    expect(all.total).toBe(2)
    expect(all.items.map((i: any) => i.user.name)).toEqual(['Ali', 'Reza'])
    expect(all.items[1].imageUrl).toBe('https://pub/u2/p2')

    const approved = (await app.inject({ method: 'GET', url: '/admin/photo-checks?verdict=approved', headers })).json()
    expect(approved.items.map((i: any) => i.user.name)).toEqual(['Reza'])
    expect(approved.pageCount).toBe(1)
  })

  it('500s when the list query fails', async () => {
    const res = await withTableBroken('photo_ai_checks', () =>
      app.inject({ method: 'GET', url: '/admin/photo-checks', headers }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photo_checks_fetch_failed' })
  })

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/photo-checks' })
    expect(res.statusCode).toBe(401)
  })
})
