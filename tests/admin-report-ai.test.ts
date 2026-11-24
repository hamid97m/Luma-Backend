import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('admin API for AI report review', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const get = (url: string) => app.inject({ method: 'GET', url, headers })

  it('moderation config carries reportAiMode + reportSuspendDays and validates them', async () => {
    expect((await get('/admin/moderation/config')).json()).toEqual({
      photoReportThreshold: 3, reportAiMode: 'auto', reportSuspendDays: 3,
    })
    const ok = await app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers, payload: { reportAiMode: 'review', reportSuspendDays: 7 },
    })
    expect(ok.json()).toEqual({ photoReportThreshold: 3, reportAiMode: 'review', reportSuspendDays: 7 })

    for (const [payload, error] of [
      [{ reportAiMode: 'yolo' }, 'invalid_report_ai_mode'],
      [{ reportSuspendDays: 0 }, 'invalid_report_suspend_days'],
      [{ reportSuspendDays: 366 }, 'invalid_report_suspend_days'],
      [{ reportSuspendDays: 2.5 }, 'invalid_report_suspend_days'],
    ] as const) {
      const res = await app.inject({ method: 'PUT', url: '/admin/moderation/config', headers, payload })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error })
    }
  })

  it('report detail shows the latest AI check per report and suspendedUntil', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    const reporter = await createUser({ name: 'Sara' })
    const reported = await createUser({ name: 'Reza', suspended_until: until })
    const r1 = await insertRow('reports', { reporter_id: reporter.id, reported_id: reported.id, context: 'chat', reason: 'harassment', status: 'resolved_suspended' })
    const other = await createUser()
    await insertRow('reports', { reporter_id: other.id, reported_id: reported.id, context: 'discovery', reason: 'other', status: 'pending' })
    await insertRow('report_ai_checks', { report_id: r1.id, reporter_id: reporter.id, reported_id: reported.id, mode: 'auto', verdict: 'error', created_at: '2026-11-20T00:00:00Z' })
    await insertRow('report_ai_checks', {
      report_id: r1.id, reporter_id: reporter.id, reported_id: reported.id, mode: 'auto', verdict: 'suspend',
      category: 'harassment', quote: 'q', explanation: 'e', reporter_notified_at: '2026-11-21T00:00:01Z', created_at: '2026-11-21T00:00:00Z',
    })

    const body = (await get(`/admin/reports/user/${reported.id}`)).json()
    expect(new Date(body.reportedUser.suspendedUntil).toISOString()).toBe(until)
    const byId = Object.fromEntries(body.reports.map((r: any) => [r.id, r]))
    expect(byId[r1.id].ai).toEqual({
      verdict: 'suspend', category: 'harassment', quote: 'q', explanation: 'e',
      createdAt: '2026-11-21T00:00:00.000Z', reporterNotifiedAt: '2026-11-21T00:00:01.000Z',
    })
    const pending = body.reports.find((r: any) => r.id !== r1.id)
    expect(pending.ai).toBeNull()

    // Pending queue: reportedUser.suspendedUntil.
    const queue = (await get('/admin/reports')).json()
    expect(new Date(queue.items[0].reportedUser.suspendedUntil).toISOString()).toBe(until)

    // Resolved history includes resolved_suspended.
    const resolved = (await get('/admin/reports?status=resolved')).json()
    expect(resolved.items.map((i: any) => i.status)).toEqual(['resolved_suspended'])
  })

  it('unsuspends a user; users list filters status=suspended and exposes suspendedUntil', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    const s = await createUser({ name: 'Susp', suspended_until: until })
    await createUser({ name: 'Expired', suspended_until: new Date(Date.now() - 1000).toISOString() })
    await createUser({ name: 'Normal' })

    const list = (await get('/admin/users?status=suspended')).json()
    expect(list.items.map((i: any) => i.id)).toEqual([s.id])
    expect(new Date(list.items[0].suspendedUntil).toISOString()).toBe(until)
    const detail = (await get(`/admin/users/${s.id}`)).json()
    expect(new Date(detail.user.suspendedUntil).toISOString()).toBe(until)

    const res = await app.inject({ method: 'POST', url: `/admin/users/${s.id}/unsuspend`, headers })
    expect(res.json()).toEqual({ ok: true })
    expect((await sql`select suspended_until from users where id = ${s.id}`)[0].suspended_until).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/admin/users/nope/unsuspend', headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/admin/users/${s.id}/unsuspend` })).statusCode).toBe(401)
  })

  it('lists the AI review log, newest first, paginated', async () => {
    const reporter = await createUser({ name: 'Sara' })
    const reported = await createUser({ name: 'Reza' })
    const r = await insertRow('reports', { reporter_id: reporter.id, reported_id: reported.id, context: 'chat', reason: 'other', status: 'pending' })
    await insertRow('report_ai_checks', { report_id: r.id, reporter_id: reporter.id, reported_id: reported.id, mode: 'auto', verdict: 'skipped', skip_reason: 'seed_user', created_at: '2026-11-20T00:00:00Z' })
    const c2 = await insertRow('report_ai_checks', {
      report_id: r.id, reporter_id: reporter.id, reported_id: reported.id, mode: 'review', verdict: 'would_ban',
      category: 'insult', quote: 'q', explanation: 'e', created_at: '2026-11-21T00:00:00Z',
    })

    const res = await get('/admin/report-ai-checks?page=1')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ total: 2, page: 1, pageCount: 1 })
    expect(body.items[0]).toEqual({
      id: c2.id, reportId: r.id, reporter: { id: reporter.id, name: 'Sara' }, reported: { id: reported.id, name: 'Reza' },
      mode: 'review', verdict: 'would_ban', category: 'insult', quote: 'q', explanation: 'e', skipReason: null,
      reporterNotifiedAt: null, createdAt: '2026-11-21T00:00:00.000Z',
    })
    expect(body.items[1].skipReason).toBe('seed_user')
    expect((await app.inject({ method: 'GET', url: '/admin/report-ai-checks' })).statusCode).toBe(401)
  })
})
