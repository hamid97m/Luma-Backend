import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// Storage still goes through supabase-js; the DB part is real Postgres.
vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { storageMock, createReport } from './helpers/profile.js'

const PHOTO_ID = '11111111-1111-1111-1111-111111111111'

describe('POST /profile/me/photos/confirm — resume', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let storage: ReturnType<typeof storageMock>
  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    storage = storageMock(() => 'https://cdn/me-1/photo.jpg')
    vi.mocked(db.storage.from).mockReturnValue(storage as any)
  })

  const confirm = () => app.inject({
    method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH,
    payload: { photoId: PHOTO_ID },
  })

  it('clears the pause and resolves pending reports when the user was paused', async () => {
    const me = await createUser({ paused_at: '2026-08-31T00:00:00Z' })
    authAs(me)
    const pending = await createReport(me.id)
    const dismissed = await createReport(me.id, { status: 'dismissed' })
    const someoneElse = await createReport((await createUser()).id)

    const res = await confirm()

    expect(res.statusCode).toBe(200)
    expect((await sql`select paused_at from users where id = ${me.id}`)[0].paused_at).toBeNull()
    const statuses = Object.fromEntries(
      (await sql`select id, status, resolved_at from reports`).map((r) => [r.id, r]))
    expect(statuses[pending.id].status).toBe('resolved_reuploaded')
    expect(statuses[pending.id].resolved_at).not.toBeNull()
    expect(statuses[dismissed.id].status).toBe('dismissed')
    expect(statuses[someoneElse.id].status).toBe('pending')
  })

  it('does not touch reports when the user was not paused', async () => {
    const me = await createUser()
    authAs(me)
    const report = await createReport(me.id)

    const res = await confirm()

    expect(res.statusCode).toBe(200)
    expect((await sql`select status from reports where id = ${report.id}`)[0].status).toBe('pending')
  })

  it('evicts the oldest photo to let a paused user at the cap self-resume', async () => {
    // Auth preHandler sees a non-null paused_at, so req.isPaused === true.
    const me = await createUser({ paused_at: '2026-08-31T00:00:00Z' })
    authAs(me)
    const photos = []
    for (let i = 0; i < 6; i++) photos.push(await createPhoto(me.id, i))
    const oldest = photos[0]
    await createReport(me.id)

    const res = await confirm()

    expect(res.statusCode).toBe(200)
    expect(storage.remove).toHaveBeenCalledWith([`${me.id}/${oldest.id}`])
    expect(res.json()).toEqual({
      photo: { id: PHOTO_ID, url: 'https://cdn/me-1/photo.jpg', position: oldest.position },
    })
    const rows = await sql`select id, position from user_photos where user_id = ${me.id} order by position`
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ id: PHOTO_ID, position: 0 })
    expect(rows.some((r) => r.id === oldest.id)).toBe(false)
    expect((await sql`select paused_at from users where id = ${me.id}`)[0].paused_at).toBeNull()
    expect((await sql`select status from reports`)[0].status).toBe('resolved_reuploaded')
  })
})
