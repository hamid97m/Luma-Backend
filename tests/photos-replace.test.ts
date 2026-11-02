import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/server.js'
import { scheduleMainPhotoCheck } from '../src/moderation/photoAiCheck.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { PHOTO_URL_BASE, createReport, photoFileExists, seedPhotoFile, withFailingWrites } from './helpers/profile.js'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali' })
  authAs(me)
})

async function addPhotos(userId: string, n: number) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await createPhoto(userId, i))
  return out
}

describe('POST /profile/me/photos/upload-url (replace bypasses cap)', () => {
  const uploadUrl = (replacePhotoId: string) => app.inject({
    method: 'POST', url: '/profile/me/photos/upload-url',
    headers: AUTH, payload: { contentType: 'image/jpeg', replacePhotoId },
  })

  it('allows the request at 6 photos when replacePhotoId matches an owned photo', async () => {
    const [p1] = await addPhotos(me.id, 6)

    const res = await uploadUrl(p1.id)

    expect(res.statusCode).toBe(200)
    expect(res.json().uploadUrl).toMatch(/^http:\/\/api\.test\/media-upload\/[^/]+$/)
  })

  it('still returns 400 at 6 photos when replacePhotoId is not owned', async () => {
    await addPhotos(me.id, 6)
    const other = await createUser()
    const [theirs] = await addPhotos(other.id, 1)

    for (const id of ['not-mine', theirs.id]) {
      const res = await uploadUrl(id)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'max_photos_reached' })
    }
  })
})

describe('POST /profile/me/photos/:photoId/replace', () => {
  const replace = (photoId: string, newPhotoId: unknown) => app.inject({
    method: 'POST', url: `/profile/me/photos/${photoId}/replace`,
    headers: AUTH, payload: { newPhotoId },
  })

  it('returns 404 when the old photo is not found', async () => {
    const res = await replace(randomUUID(), randomUUID())
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'photo_not_found' })
  })

  it('returns 404 (not 500) for a malformed old photo id', async () => {
    const res = await replace('old-photo', randomUUID())
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'photo_not_found' })
  })

  it('returns 400 when newPhotoId equals the old id', async () => {
    const [old] = await addPhotos(me.id, 1)
    const res = await replace(old.id, old.id)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_photo_id' })
  })

  it('swaps the new photo into the old photo position and returns it', async () => {
    const [p0, p1, old] = await addPhotos(me.id, 3)
    const newId = randomUUID()
    await seedPhotoFile(me.id, old.id)
    await seedPhotoFile(me.id, newId)

    const res = await replace(old.id, newId)

    const url = `${PHOTO_URL_BASE}/${me.id}/${newId}`
    expect(res.statusCode).toBe(200)
    expect(photoFileExists(me.id, old.id)).toBe(false)
    expect(photoFileExists(me.id, newId)).toBe(true)
    expect(res.json()).toEqual({ photo: { id: newId, url, position: 2 } })
    expect(await sql`select id, position from user_photos where user_id = ${me.id} order by position`).toEqual([
      { id: p0.id, position: 0 }, { id: p1.id, position: 1 }, { id: newId, position: 2 },
    ])
    expect(scheduleMainPhotoCheck).not.toHaveBeenCalled()
  })

  it('re-checks the main photo when the main photo is swapped', async () => {
    const [main] = await addPhotos(me.id, 1)
    expect((await replace(main.id, randomUUID())).statusCode).toBe(200)
    expect(scheduleMainPhotoCheck).toHaveBeenCalledWith(me.id, expect.anything())
  })

  it('lifts a photo-review pause and resolves pending reports', async () => {
    const paused = await createUser({ paused_at: '2026-10-01T00:00:00Z' })
    authAs(paused)
    const [old] = await addPhotos(paused.id, 1)
    const report = await createReport(paused.id)

    expect((await replace(old.id, randomUUID())).statusCode).toBe(200)

    expect((await sql`select paused_at from users where id = ${paused.id}`)[0].paused_at).toBeNull()
    expect((await sql`select status from reports where id = ${report.id}`)[0].status).toBe('resolved_reuploaded')
  })

  for (const bad of ['new-photo', 123, undefined]) {
    it(`returns 400 invalid_photo_id for a malformed newPhotoId (${String(bad)}) and keeps the old photo`, async () => {
      const [, old] = await addPhotos(me.id, 2)
      await seedPhotoFile(me.id, old.id)

      const res = await replace(old.id, bad)

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_photo_id' })
      expect(await sql`select id, position from user_photos where id = ${old.id}`).toEqual([{ id: old.id, position: 1 }])
      expect(photoFileExists(me.id, old.id)).toBe(true)
    })
  }

  it('returns 500 photo_replace_failed when the new row cannot be inserted', async () => {
    const [, old] = await addPhotos(me.id, 2)
    const res = await withFailingWrites('user_photos', 'insert', () => replace(old.id, randomUUID()))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photo_replace_failed' })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/old-photo/replace',
      payload: { newPhotoId: 'new-photo' },
    })
    expect(res.statusCode).toBe(401)
  })
})
