import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin reports', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('lists pending reports grouped per user with a count', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'pending_report_summary') {
        return chainable({
          data: [{ reported_id: 'u1', report_count: 3, reasons: ['fake'], contexts: ['discovery'], latest_at: 't' }],
          count: 1, error: null,
        })
      }
      if (table === 'users') {
        return chainable({
          data: [{ id: 'u1', name: 'Sara', banned_at: null, deleted_at: null, user_photos: [{ url: 'p.jpg', position: 0 }] }],
          error: null,
        })
      }
      return chainable({ data: [], error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/reports?status=pending', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ reportCount: 3, reportedUser: { id: 'u1', name: 'Sara' } })
  })

  it('excludes soft-deleted reported users from the resolved list DB-side', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'reports') {
        return chainable({
          data: [{
            id: 'r1', reported_id: 'u1', reason: 'fake', context: 'discovery',
            status: 'dismissed', created_at: 't1', resolved_at: 't2',
            reported: { id: 'u1', name: 'Sara', deleted_at: null },
          }],
          count: 1, error: null,
        }, log)
      }
      return chainable({ data: [], error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/reports?status=resolved', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0].reportedUser).toEqual({ id: 'u1', name: 'Sara' })

    const select = log.find((c) => c.method === 'select')
    expect(select?.args[0]).toContain('users!reports_reported_id_fkey!inner(id, name, deleted_at)')
    expect(log).toContainEqual({ method: 'is', args: ['reported.deleted_at', null] })
  })

  it('drops reports filed by soft-deleted reporters from the per-user list', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return chainable({ data: { id: 'u1', name: 'Sara', user_photos: [] }, error: null })
      }
      if (table === 'reports') {
        return chainable({
          data: [
            {
              id: 'r1', reporter_id: 'alive-1', context: 'discovery', reason: 'fake',
              note: null, match_id: null, status: 'pending', created_at: 't1',
              reporter: { id: 'alive-1', name: 'Ali', deleted_at: null },
            },
            {
              id: 'r2', reporter_id: 'gone-1', context: 'chat', reason: 'spam',
              note: null, match_id: null, status: 'pending', created_at: 't2',
              reporter: { id: 'gone-1', name: 'Ghost', deleted_at: '2026-09-01T00:00:00Z' },
            },
          ],
          error: null,
        })
      }
      return chainable({ data: [], error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/reports/user/u1', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0]).toMatchObject({ id: 'r1', reporterId: 'alive-1', reporterName: 'Ali' })
  })

  it('bans a reported user and resolves their pending reports', async () => {
    const userUpdate = vi.fn(() => chainable({ data: { id: 'u1' }, error: null }))
    const reportsUpdate = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return { update: userUpdate } as any
      if (table === 'reports') return { update: reportsUpdate } as any
      return chainable({ error: null })
    })

    const res = await app.inject({
      method: 'POST', url: '/admin/reports/user/u1/resolve', headers,
      payload: { action: 'ban' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((userUpdate.mock.calls[0][0] as any).banned_at).toBeTruthy()
    expect((reportsUpdate.mock.calls[0][0] as any).status).toBe('resolved_banned')
  })

  it('dismisses without banning', async () => {
    const userUpdate = vi.fn(() => chainable({ data: { id: 'u1' }, error: null }))
    const reportsUpdate = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return { update: userUpdate } as any
      if (table === 'reports') return { update: reportsUpdate } as any
      return chainable({ error: null })
    })

    const res = await app.inject({
      method: 'POST', url: '/admin/reports/user/u1/resolve', headers,
      payload: { action: 'dismiss' },
    })
    expect(res.statusCode).toBe(200)
    expect(userUpdate).not.toHaveBeenCalled()
    expect((reportsUpdate.mock.calls[0][0] as any).status).toBe('dismissed')
  })

  it('rejects an unknown action', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/reports/user/u1/resolve', headers,
      payload: { action: 'nuke' },
    })
    expect(res.statusCode).toBe(400)
  })
})
