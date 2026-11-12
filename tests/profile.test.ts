import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { buildApp } from '../src/server.js'
import { scheduleUserGeo } from '../src/geo/resolveCity.js'
import { scheduleMainPhotoCheck } from '../src/moderation/photoAiCheck.js'
import { maybeQualifyReferral } from '../src/referrals/rewards.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { photoFileExists, seedPhotoFile, withFailingWrites } from './helpers/profile.js'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali', age: 25, bio: null, location: 'Tehran' })
  authAs(me)
})

const userRow = async (id = me.id) => (await sql`select * from users where id = ${id}`)[0]
const put = (payload: unknown) =>
  app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: payload as any })

describe('GET /profile/me', () => {
  it('returns full profile with photos', async () => {
    const p1 = await createPhoto(me.id, 1, { url: 'https://img/1' })
    const p0 = await createPhoto(me.id, 0, { url: 'https://img/0' })

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: me.id, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null,
      interests: [], location: 'Tehran', icebreaker_prompt: null, icebreaker_answer: null, phone: null,
      is_active: true, paused_at: null, locale: null, account_status: 'active',
      photos: [
        { id: p0.id, url: 'https://img/0', position: 0 },
        { id: p1.id, url: 'https://img/1', position: 1 },
      ],
      setupComplete: true,
      paused: false,
    })
  })

  it('promotes a finished preparing signup on read', async () => {
    await sql`update users set account_status = 'preparing' where id = ${me.id}`
    await createPhoto(me.id, 0)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect((await userRow()).account_status).toBe('active')
  })
})

describe('PUT /profile/me', () => {
  it('updates bio and returns updated profile', async () => {
    const res = await put({ bio: 'سلام' })

    expect(res.statusCode).toBe(200)
    expect(res.json().bio).toBe('سلام')
    expect(res.json()).toMatchObject({ photos: [], setupComplete: true })
    expect((await userRow()).bio).toBe('سلام')
    expect(maybeQualifyReferral).toHaveBeenCalledWith(me.id)
  })

  it('ignores fields outside the allowlist, and 400s when nothing allowed is sent', async () => {
    const res = await put({ banned_at: '2026-01-01T00:00:00Z', premium_until: '2099-01-01T00:00:00Z' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'no_fields' })
    const row = await userRow()
    expect(row.banned_at).toBeNull()
    expect(row.premium_until).toBeNull()
  })

  it('stores interests arrays, including an empty one', async () => {
    let res = await put({ interests: ['music', 'hiking'] })
    expect(res.statusCode).toBe(200)
    expect(res.json().interests).toEqual(['music', 'hiking'])
    expect((await userRow()).interests).toEqual(['music', 'hiking'])

    res = await put({ interests: [] })
    expect(res.statusCode).toBe(200)
    expect((await userRow()).interests).toEqual([])
  })

  it('rejects a numeric name with 400 invalid_name', async () => {
    const res = await put({ name: '12345' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_name' })
  })

  it('rejects a Persian-digit name with 400 invalid_name', async () => {
    const res = await put({ name: '۱۲۳' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_name' })
  })

  it('accepts and trims a valid name', async () => {
    const res = await put({ name: '  Sina  ' })

    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Sina')
    expect((await userRow()).name).toBe('Sina')
  })

  it('rejects an empty city with 400 invalid_location', async () => {
    const res = await put({ location: '   ' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_location' })
  })

  it('rejects a city with digits with 400 invalid_location', async () => {
    const res = await put({ location: 'تهران۲' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_location' })
  })

  it('accepts and trims a valid city', async () => {
    const res = await put({ location: '  تهران  ' })

    expect(res.statusCode).toBe(200)
    expect(res.json().location).toBe('تهران')
  })

  it('clears the hidden geo on a city change and re-resolves it in the background', async () => {
    await sql`update users set geo_city = 'Tehran', geo_country = 'IR' where id = ${me.id}`

    const res = await put({ location: 'مشهد' })

    expect(res.statusCode).toBe(200)
    const row = await userRow()
    expect(row).toMatchObject({ location: 'مشهد', geo_city: null, geo_country: null })
    expect(scheduleUserGeo).toHaveBeenCalledWith(me.id, 'مشهد', expect.anything())
    expect(res.json()).not.toHaveProperty('geo_city')
  })

  it('leaves the hidden geo alone when the city is not part of the update', async () => {
    await sql`update users set geo_city = 'Tehran', geo_country = 'IR' where id = ${me.id}`

    const res = await put({ bio: 'hi', geo_city: 'Paris' })

    expect(res.statusCode).toBe(200)
    expect(await userRow()).toMatchObject({ bio: 'hi', geo_city: 'Tehran', geo_country: 'IR' })
    expect(scheduleUserGeo).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range age with 400 invalid_age', async () => {
    const res = await put({ age: 12 })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_age' })
  })

  it('rejects a non-numeric/empty age with 400 invalid_age', async () => {
    const res = await put({ age: '' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_age' })
  })

  it('promotes a finished signup from preparing to active', async () => {
    await sql`update users set account_status = 'preparing', age = 0, location = null where id = ${me.id}`
    await createPhoto(me.id, 0)

    const res = await put({ location: 'Tehran', age: 25 })

    expect(res.statusCode).toBe(200)
    expect((await userRow()).account_status).toBe('active')
  })

  it('schedules the main-photo AI check when gender is saved', async () => {
    const res = await put({ gender: 'man' })
    expect(res.statusCode).toBe(200)
    expect(scheduleMainPhotoCheck).toHaveBeenCalledWith(me.id, expect.anything())
  })

  it('returns 500 update_failed for a value Postgres rejects (thrown error is caught)', async () => {
    const res = await put({ gender: 'robot' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
    expect((await userRow()).gender).toBe('man')
  })

  it('pauses the account by setting is_active to false', async () => {
    const res = await put({ is_active: false })

    expect(res.statusCode).toBe(200)
    expect(res.json().is_active).toBe(false)
    expect((await userRow()).is_active).toBe(false)
  })
})

describe('POST /profile/me/write-access', () => {
  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/profile/me/write-access', headers: AUTH, payload: payload as any })

  it('records the grant', async () => {
    const res = await post({ granted: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await userRow()).allows_write_to_pm).toBe(true)
  })

  it('rejects a non-boolean', async () => {
    const res = await post({ granted: 'yes' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_granted' })
  })

  it('returns 500 update_failed when the write fails', async () => {
    const res = await withFailingWrites('users', 'update', () => post({ granted: false }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
  })
})

describe('DELETE /profile/me', () => {
  const del = () => app.inject({ method: 'DELETE', url: '/profile/me', headers: AUTH })

  it('removes photos from storage and wipes the profile', async () => {
    await sql`update users set bio = 'b', interests = ${['x']}, locale = 'en', geo_city = 'Tehran', geo_country = 'IR',
      icebreaker_prompt = 'p', icebreaker_answer = 'a' where id = ${me.id}`
    const p1 = await createPhoto(me.id, 0)
    const p2 = await createPhoto(me.id, 1)
    const other = await createUser()
    const theirs = await createPhoto(other.id, 0)
    for (const [u, p] of [[me, p1], [me, p2], [other, theirs]]) await seedPhotoFile(u.id, p.id)

    const res = await del()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(photoFileExists(me.id, p1.id)).toBe(false)
    expect(photoFileExists(me.id, p2.id)).toBe(false)
    expect(photoFileExists(other.id, theirs.id)).toBe(true)
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${me.id}`)[0].n).toBe(0)
    expect(await userRow()).toMatchObject({
      name: '', bio: null, interests: [], location: null, geo_city: null, geo_country: null,
      icebreaker_prompt: null, icebreaker_answer: null,
      age: 0, is_active: false, account_status: 'preparing',
      // NULL = "never chose a language" → a re-signup gets the picker again.
      locale: null,
      deleted_at: expect.any(String),
    })
  })

  it('succeeds without photos and leaves other users\' files alone', async () => {
    const other = await createUser()
    const theirs = await createPhoto(other.id, 0)
    await seedPhotoFile(other.id, theirs.id)

    const res = await del()

    expect(res.statusCode).toBe(200)
    expect(photoFileExists(other.id, theirs.id)).toBe(true)
    expect((await userRow()).deleted_at).not.toBeNull()
  })

  it('still deletes the photo rows and the profile when the files cannot be removed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p1 = await createPhoto(me.id, 0)
    await seedPhotoFile(me.id, p1.id)
    const userDir = join(process.env.MEDIA_DIR!, 'public', 'profile-photos', me.id)
    await chmod(userDir, 0o500) // unlink fails with EACCES
    let res
    try {
      res = await del()
    } finally {
      await chmod(userDir, 0o700)
    }

    expect(res.statusCode).toBe(200)
    expect(errorSpy).toHaveBeenCalled()
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
    expect((await userRow()).deleted_at).not.toBeNull()
    errorSpy.mockRestore()
  })

  it('clears the push tokens of all my devices (and only mine)', async () => {
    const other = await createUser()
    await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at) values
      (${me.id}, 'd1', 'android', 'mine-1', now()),
      (${me.id}, 'd2', 'android', 'mine-2', now()),
      (${other.id}, 'd3', 'android', 'theirs', now())`

    expect((await del()).statusCode).toBe(200)

    const rows = await sql`select user_id, push_token, push_token_at from user_devices order by device_id`
    expect(rows.map((r) => [r.push_token, r.push_token_at === null])).toEqual([
      [null, true], [null, true], ['theirs', false],
    ])
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/profile/me' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 500 when photo deletion fails', async () => {
    await createPhoto(me.id, 0)

    const res = await withFailingWrites('user_photos', 'delete', () => del())

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'delete_failed' })
    expect((await userRow()).deleted_at).toBeNull()
  })

  it('returns 500 when the profile wipe fails', async () => {
    const res = await withFailingWrites('users', 'update', () => del())
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'delete_failed' })
  })
})

describe('preHandler — deleted account gate', () => {
  it('returns 401 account_deleted for a soft-deleted user on a protected route', async () => {
    const gone = await createUser({ deleted_at: '2026-08-01T00:00:00Z' })
    authAs(gone)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_deleted' })
  })
})
