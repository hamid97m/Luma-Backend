import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin photo checks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('summarizes checks and prices the tokens at the peak rate', async () => {
    vi.mocked(db.from).mockReturnValue(chainable({
      data: {
        total: 10, approved: 8, rejected: 2, total_24h: 3, rejected_24h: 1, total_7d: 10, rejected_7d: 2,
        prompt_tokens: 6000, completion_tokens: 100, by_reason: { no_face: 2 },
      },
      error: null,
    }))

    const res = await app.inject({ method: 'GET', url: '/admin/photo-checks/stats', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      total: 10, approved: 8, rejected: 2,
      last24h: { total: 3, rejected: 1 }, last7d: { total: 10, rejected: 2 },
      byReason: { no_face: 2 }, promptTokens: 6000, completionTokens: 100,
    })
    expect(body.estimatedCostUsd).toBeCloseTo(6000 * 0.3e-6 + 100 * 1.2e-6)
  })

  it('lists rejected checks with a signed evidence URL and approved ones with the public URL', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValue(chainable({
      data: [
        {
          photo_id: 'p1', approved: false, reason: 'nudity', photo_url: 'https://pub/u1/p1',
          evidence_path: 'u1/p1', created_at: 't1',
          user: { id: 'u1', name: 'Ali', gender: 'man', paused_at: 't1', banned_at: null, deleted_at: null },
        },
        {
          photo_id: 'p2', approved: true, reason: null, photo_url: 'https://pub/u2/p2',
          evidence_path: null, created_at: 't0',
          user: { id: 'u2', name: 'Reza', gender: 'man', paused_at: null, banned_at: null, deleted_at: null },
        },
      ],
      count: 2, error: null,
    }, log))
    const createSignedUrls = vi.fn().mockResolvedValue({ data: [{ path: 'u1/p1', signedUrl: 'https://signed/u1/p1' }] })
    vi.mocked(db.storage.from).mockReturnValue({ createSignedUrls } as any)

    const res = await app.inject({ method: 'GET', url: '/admin/photo-checks?verdict=rejected&page=1', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(log).toContainEqual({ method: 'eq', args: ['approved', false] })
    expect(db.storage.from).toHaveBeenCalledWith('photo-ai-evidence')
    expect(createSignedUrls).toHaveBeenCalledWith(['u1/p1'], 3600)
    expect(body.total).toBe(2)
    expect(body.items[0]).toEqual({
      photoId: 'p1',
      user: { id: 'u1', name: 'Ali', gender: 'man', pausedAt: 't1', bannedAt: null, deletedAt: null },
      approved: false, reason: 'nudity', createdAt: 't1', imageUrl: 'https://signed/u1/p1',
    })
    expect(body.items[1].imageUrl).toBe('https://pub/u2/p2')
  })

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/photo-checks' })
    expect(res.statusCode).toBe(401)
  })
})
