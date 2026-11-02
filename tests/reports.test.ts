import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// Moderation side effects belong to another area — assert they're invoked.
vi.mock('../src/moderation/autoPause.js', () => ({
  maybeWarnFakePhoto: vi.fn().mockResolvedValue(false),
  maybeAutoPauseForReports: vi.fn().mockResolvedValue(false),
}))

import { buildApp } from '../src/server.js'
import { maybeWarnFakePhoto, maybeAutoPauseForReports } from '../src/moderation/autoPause.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

describe('POST /reports', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let reported: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ name: 'Ali' })
    reported = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
    authAs(me)
  })

  const report = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/reports', headers: AUTH, payload })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/reports', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('creates a discovery report and a block row', async () => {
    const res = await report({ reportedUserId: reported.id, context: 'discovery', reason: 'fake', note: '  looks fake  ' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const rows = await sql`select reporter_id, reported_id, context, reason, note, match_id, status from reports`
    expect(rows).toEqual([{
      reporter_id: me.id, reported_id: reported.id, context: 'discovery', reason: 'fake',
      note: 'looks fake', match_id: null, status: 'pending',
    }])
    expect(await sql`select blocker_id, blocked_id from blocks`).toEqual([{ blocker_id: me.id, blocked_id: reported.id }])
    expect(maybeWarnFakePhoto).toHaveBeenCalledWith(reported.id)
    expect(maybeAutoPauseForReports).toHaveBeenCalledWith(reported.id)
  })

  it('does not warn about a fake photo for other reasons', async () => {
    await report({ reportedUserId: reported.id, context: 'discovery', reason: 'spam' })
    expect(maybeWarnFakePhoto).not.toHaveBeenCalled()
    expect(maybeAutoPauseForReports).toHaveBeenCalledWith(reported.id)
  })

  it('rejects reporting yourself', async () => {
    const res = await report({ reportedUserId: me.id, context: 'discovery', reason: 'fake' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'cannot_report_self' })
  })

  it('rejects an invalid reason', async () => {
    const res = await report({ reportedUserId: reported.id, context: 'discovery', reason: 'nonsense' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_report' })
  })

  it('is idempotent when a pending report already exists (and the block too)', async () => {
    await insertRow('reports', { reporter_id: me.id, reported_id: reported.id, context: 'discovery', reason: 'fake', status: 'pending' })
    await insertRow('blocks', { blocker_id: me.id, blocked_id: reported.id })

    const res = await report({ reportedUserId: reported.id, context: 'discovery', reason: 'fake' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await sql`select count(*)::int as n from reports`)[0].n).toBe(1)
    expect((await sql`select count(*)::int as n from blocks`)[0].n).toBe(1)
    // A duplicate pending report doesn't re-send the fake-photo warning.
    expect(maybeWarnFakePhoto).not.toHaveBeenCalled()
    expect(maybeAutoPauseForReports).toHaveBeenCalledWith(reported.id)
  })

  it('returns 404 when the reported user is soft-deleted', async () => {
    await sql`update users set deleted_at = '2026-09-01T00:00:00Z' where id = ${reported.id}`
    const res = await report({ reportedUserId: reported.id, context: 'discovery', reason: 'fake' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
    expect(await sql`select id from reports`).toHaveLength(0)
  })

  it('returns 404 (not 500) for a missing or malformed reported user id', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'reported-1']) {
      const res = await report({ reportedUserId: id, context: 'discovery', reason: 'fake' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'user_not_found' })
    }
  })

  it('stores the matchId when the reporter participates in it', async () => {
    const m = await createMatch(reported.id, me.id)
    const res = await report({ reportedUserId: reported.id, context: 'chat', reason: 'harassment', matchId: m.id })
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select match_id from reports`
    expect(row.match_id).toBe(m.id)
  })

  it('ignores a matchId the reporter is not part of (stores null)', async () => {
    const x = await createUser()
    const theirs = await createMatch(x.id, reported.id)
    const res = await report({ reportedUserId: reported.id, context: 'chat', reason: 'harassment', matchId: theirs.id })
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select match_id from reports`
    expect(row.match_id).toBeNull()
  })

  it('ignores a malformed matchId (stores null, no 500)', async () => {
    const res = await report({ reportedUserId: reported.id, context: 'chat', reason: 'other', matchId: 'match-9' })
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select match_id from reports`
    expect(row.match_id).toBeNull()
  })

  it('ignores matchId for a discovery report', async () => {
    const m = await createMatch(me.id, reported.id)
    await report({ reportedUserId: reported.id, context: 'discovery', reason: 'other', matchId: m.id })
    const [row] = await sql`select match_id from reports`
    expect(row.match_id).toBeNull()
  })
})
