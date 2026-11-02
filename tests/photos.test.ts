import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// Storage still goes through supabase-js; the DB part is real Postgres.
vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { scheduleMainPhotoCheck } from '../src/moderation/photoAiCheck.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { storageMock } from './helpers/profile.js'

const positions = (userId: string) =>
  sql`select id, position from user_photos where user_id = ${userId} order by position`

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let storage: ReturnType<typeof storageMock>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali' })
  authAs(me)
  storage = storageMock()
  vi.mocked(db.storage.from).mockReturnValue(storage as any)
})

async function addPhotos(userId: string, n: number) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await createPhoto(userId, i))
  return out
}

describe('POST /profile/me/photos/upload-url', () => {
  const uploadUrl = (payload: Record<string, unknown> = { contentType: 'image/jpeg' }) =>
    app.inject({ method: 'POST', url: '/profile/me/photos/upload-url', headers: AUTH, payload })

  it('returns 400 when user already has 6 photos', async () => {
    await addPhotos(me.id, 6)

    const res = await uploadUrl()

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('returns uploadUrl and photoId (no publicUrl, no pre-insert) on success', async () => {
    await addPhotos(me.id, 1)

    const res = await uploadUrl()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('uploadUrl', 'https://cdn.test/signed-upload')
    expect(body).toHaveProperty('photoId')
    expect(body).not.toHaveProperty('publicUrl')
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(`${me.id}/${body.photoId}`)
    expect(await positions(me.id)).toHaveLength(1)
  })

  it('counts only the caller\'s photos toward the cap', async () => {
    const other = await createUser()
    await addPhotos(other.id, 6)
    expect((await uploadUrl()).statusCode).toBe(200)
  })
})

describe('POST /profile/me/photos/confirm', () => {
  const confirm = (photoId: unknown) =>
    app.inject({ method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH, payload: { photoId } })

  it('returns 400 for a missing photoId', async () => {
    const res = await app.inject({ method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_photo_id' })
  })

  it('returns 400 when user already has 6 photos', async () => {
    await addPhotos(me.id, 6)

    const res = await confirm(randomUUID())

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('returns 409 when photoId already confirmed', async () => {
    const [existing] = await addPhotos(me.id, 1)

    const res = await confirm(existing.id)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'photo_already_confirmed' })
  })

  it('inserts photo row and returns photo object', async () => {
    await addPhotos(me.id, 1)
    const newId = randomUUID()

    const res = await confirm(newId)

    const url = `https://cdn.test/profile-photos/${me.id}/${newId}`
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ photo: { id: newId, url, position: 1 } })
    const [row] = await sql`select user_id, url, position from user_photos where id = ${newId}`
    expect(row).toEqual({ user_id: me.id, url, position: 1 })
    // Not the main photo → no AI check.
    expect(scheduleMainPhotoCheck).not.toHaveBeenCalled()
  })

  it('schedules the main-photo check for a first photo', async () => {
    const res = await confirm(randomUUID())
    expect(res.json().photo.position).toBe(0)
    expect(scheduleMainPhotoCheck).toHaveBeenCalledWith(me.id, expect.anything())
  })

  it('returns 500 photo_confirm_failed for a malformed photoId (insert cast error is caught)', async () => {
    const res = await confirm('not-a-uuid')
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photo_confirm_failed' })
  })
})

describe('DELETE /profile/me/photos/:photoId', () => {
  const del = (photoId: string) =>
    app.inject({ method: 'DELETE', url: `/profile/me/photos/${photoId}`, headers: AUTH })

  it('returns 404 when photo not found', async () => {
    await addPhotos(me.id, 2)
    expect((await del(randomUUID())).statusCode).toBe(404)
  })

  it('returns 404 (not 500) for a malformed photo id', async () => {
    await addPhotos(me.id, 2)
    const res = await del('nonexistent')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'photo_not_found' })
  })

  it('returns 404 for another user\'s photo', async () => {
    const other = await createUser()
    const [theirs] = await addPhotos(other.id, 2)
    expect((await del(theirs.id)).statusCode).toBe(404)
    expect(await positions(other.id)).toHaveLength(2)
  })

  it('refuses to delete the last remaining photo with 409 last_photo', async () => {
    const [only] = await addPhotos(me.id, 1)

    const res = await del(only.id)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'last_photo' })
    expect(await positions(me.id)).toHaveLength(1)
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('removes file from Supabase Storage and compacts positions', async () => {
    const [p0, p1, p2, p3] = await addPhotos(me.id, 4)

    const res = await del(p1.id)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(storage.remove).toHaveBeenCalledWith([`${me.id}/${p1.id}`])
    expect(await positions(me.id)).toEqual([
      { id: p0.id, position: 0 }, { id: p2.id, position: 1 }, { id: p3.id, position: 2 },
    ])
    expect(scheduleMainPhotoCheck).not.toHaveBeenCalled()
  })

  it('re-checks the main photo when the main photo is deleted', async () => {
    const [p0, p1] = await addPhotos(me.id, 2)

    expect((await del(p0.id)).statusCode).toBe(200)

    expect(await positions(me.id)).toEqual([{ id: p1.id, position: 0 }])
    expect(scheduleMainPhotoCheck).toHaveBeenCalledWith(me.id, expect.anything())
  })
})

describe('PATCH /profile/me/photos/reorder', () => {
  const reorder = (order: unknown) =>
    app.inject({ method: 'PATCH', url: '/profile/me/photos/reorder', headers: AUTH, payload: { order } })

  it('returns ok:true after reordering photos', async () => {
    const [a, b, c] = await addPhotos(me.id, 3)

    const res = await reorder([b.id, a.id, c.id])

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await positions(me.id)).toEqual([
      { id: b.id, position: 0 }, { id: a.id, position: 1 }, { id: c.id, position: 2 },
    ])
    expect(scheduleMainPhotoCheck).toHaveBeenCalledWith(me.id, expect.anything())
  })

  it('does not move another user\'s photos', async () => {
    const [a, b] = await addPhotos(me.id, 2)
    const other = await createUser()
    const [x, y] = await addPhotos(other.id, 2)

    expect((await reorder([y.id, x.id, b.id, a.id])).statusCode).toBe(200)

    expect(await positions(other.id)).toEqual([{ id: x.id, position: 0 }, { id: y.id, position: 1 }])
  })

  it('returns 500 instead of silently swallowing a failed position update, and rolls back', async () => {
    const [a, b, c] = await addPhotos(me.id, 3)

    // A malformed id fails its update (uuid cast) after earlier ids were staged.
    const res = await reorder([b.id, a.id, 'photo-c', c.id])

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'reorder_failed' })
    // No photo is left at a staging (negative) position.
    expect(await positions(me.id)).toEqual([
      { id: a.id, position: 0 }, { id: b.id, position: 1 }, { id: c.id, position: 2 },
    ])
    // The main-photo check still runs on the failure path.
    expect(scheduleMainPhotoCheck).toHaveBeenCalled()
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/profile/me/photos/reorder' })
    expect(res.statusCode).toBe(401)
  })
})
