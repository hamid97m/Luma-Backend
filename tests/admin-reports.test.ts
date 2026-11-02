import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, createPhoto, insertRow, sql } from './helpers/db.js'
import { createAdmin } from './helpers/admin.js'
import { withFailingWrite, withTableBroken } from './helpers/admin-db-fault.js'

describe('admin reports', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let admin: { id: string }
  let reporter: Record<string, any>
  let sara: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    ;({ admin, headers } = await createAdmin())
    reporter = await createUser({ name: 'Reporter' })
    sara = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', bio: 'hi', username: 'sara' })
  })

  const report = (reported_id: string, extra: Record<string, unknown> = {}) =>
    insertRow('reports', { reporter_id: reporter.id, reported_id, context: 'discovery', reason: 'fake', ...extra })

  it('lists pending reports grouped per user with a count, most-reported first', async () => {
    await createPhoto(sara.id, 1, { url: 'p2.jpg' })
    await createPhoto(sara.id, 0, { url: 'p.jpg' })
    await report(sara.id, { created_at: '2026-08-01T00:00:00Z' })
    // one pending report per reporter/reported pair (idx_reports_pending_unique)
    const r2 = await createUser({ name: 'R2' })
    const r3 = await createUser({ name: 'R3' })
    await report(sara.id, { reporter_id: r2.id, reason: 'spam', context: 'chat', created_at: '2026-08-02T00:00:00Z' })
    await report(sara.id, { reporter_id: r3.id, created_at: '2026-08-03T00:00:00Z' })
    await report(sara.id, { status: 'dismissed' })
    const ali = await createUser({ name: 'Ali', deleted_at: '2026-08-05T00:00:00Z' })
    await report(ali.id)

    const res = await app.inject({ method: 'GET', url: '/admin/reports?status=pending', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.pageCount).toBe(1)
    expect(body.items[0]).toEqual({
      reportedUser: { id: sara.id, name: 'Sara', photo: 'p.jpg', bannedAt: null, deletedAt: null },
      reportCount: 3,
      reasons: ['fake', 'spam'],
      contexts: ['discovery', 'chat'],
      latestAt: '2026-08-03T00:00:00.000Z',
    })
    // admins still see deleted users
    expect(body.items[1].reportedUser).toMatchObject({ id: ali.id, name: 'Ali', photo: null, deletedAt: '2026-08-05T00:00:00.000Z' })
  })

  it('lists resolved history (banned + dismissed), most recently resolved first', async () => {
    const r1 = await report(sara.id, { status: 'dismissed', resolved_at: '2026-08-01T00:00:00Z' })
    const r2 = await report(sara.id, { status: 'resolved_banned', resolved_at: '2026-08-02T00:00:00Z' })
    await report(sara.id) // pending: excluded

    const res = await app.inject({ method: 'GET', url: '/admin/reports?status=resolved', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.items.map((i: any) => i.id)).toEqual([r2.id, r1.id])
    expect(body.items[0]).toEqual({
      id: r2.id, reportedUser: { id: sara.id, name: 'Sara' }, reason: 'fake', context: 'discovery',
      status: 'resolved_banned', createdAt: r2.created_at, resolvedAt: '2026-08-02T00:00:00.000Z',
    })
  })

  it('500s when the pending summary fails', async () => {
    const res = await withTableBroken('user_photos', async () => {
      await report(sara.id)
      return app.inject({ method: 'GET', url: '/admin/reports', headers })
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'reports_fetch_failed' })
  })

  it('GET /reports/user/:userId returns the user with photos and their reports, pending first', async () => {
    await createPhoto(sara.id, 1, { url: 'b.jpg' })
    await createPhoto(sara.id, 0, { url: 'a.jpg' })
    const old = await report(sara.id, { status: 'dismissed', created_at: '2026-08-05T00:00:00Z' })
    const pending = await report(sara.id, { note: 'n', created_at: '2026-08-01T00:00:00Z' })

    const res = await app.inject({ method: 'GET', url: `/admin/reports/user/${sara.id}`, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reportedUser).toEqual({
      id: sara.id, name: 'Sara', age: 28, gender: 'woman', bio: 'hi', username: 'sara',
      telegramId: sara.telegram_id, bannedAt: null, deletedAt: null, photos: ['a.jpg', 'b.jpg'],
    })
    expect(body.reports.map((r: any) => r.id)).toEqual([pending.id, old.id])
    expect(body.reports[0]).toEqual({
      id: pending.id, reporterId: reporter.id, reporterName: 'Reporter', context: 'discovery',
      reason: 'fake', note: 'n', matchId: null, status: 'pending', createdAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('GET /reports/user/:userId 404s for an unknown or malformed id', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'nope']) {
      const res = await app.inject({ method: 'GET', url: `/admin/reports/user/${id}`, headers })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'user_not_found' })
    }
  })

  const resolve = (userId: string, action: string) =>
    app.inject({ method: 'POST', url: `/admin/reports/user/${userId}/resolve`, headers, payload: { action } })

  it('bans a reported user and resolves their pending reports', async () => {
    await report(sara.id)
    const dismissedEarlier = await report(sara.id, { status: 'dismissed' })

    const res = await resolve(sara.id, 'ban')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await sql`select banned_at from users where id = ${sara.id}`)[0].banned_at).toBeTruthy()
    const rows = await sql`select id, status, resolved_by, resolved_at from reports order by created_at`
    const resolved = rows.find((r) => r.id !== dismissedEarlier.id)!
    expect(resolved).toMatchObject({ status: 'resolved_banned', resolved_by: admin.id })
    expect(resolved.resolved_at).toBeTruthy()
    expect(rows.find((r) => r.id === dismissedEarlier.id)).toMatchObject({ status: 'dismissed', resolved_by: null })
  })

  it('dismisses without banning', async () => {
    await report(sara.id)
    const res = await resolve(sara.id, 'dismiss')
    expect(res.statusCode).toBe(200)
    expect((await sql`select banned_at from users where id = ${sara.id}`)[0].banned_at).toBeNull()
    expect((await sql`select status from reports`)[0].status).toBe('dismissed')
  })

  it('rolls back the ban when resolving the reports fails', async () => {
    await report(sara.id)
    const res = await withFailingWrite('reports', 'update', () => resolve(sara.id, 'ban'))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'resolve_failed' })
    expect((await sql`select banned_at from users where id = ${sara.id}`)[0].banned_at).toBeNull()
  })

  it('treats a malformed user id as nothing to resolve', async () => {
    const res = await resolve('nope', 'dismiss')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('rejects an unknown action', async () => {
    const res = await resolve(sara.id, 'nuke')
    expect(res.statusCode).toBe(400)
  })
})
