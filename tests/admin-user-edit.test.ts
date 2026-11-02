import { describe, it, expect, vi, beforeEach } from 'vitest'

// Cross-area: geo resolution calls DeepSeek; not under test here.
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))

import { buildApp } from '../src/server.js'
import { scheduleUserGeo } from '../src/geo/resolveCity.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken, withFailingWrite } from './helpers/admin-db-fault.js'

const SEED = {
  telegram_id: -100, is_seed: true, name: 'Seed', age: 30, gender: 'woman', looking_for: 'men',
  bio: 'old bio', location: 'Shiraz', geo_city: 'Shiraz', geo_country: 'IR', interests: ['art'],
}

describe('PUT /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let seed: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
    seed = await createUser(SEED)
    await createPhoto(seed.id, 0, { url: 'https://old0.jpg' })
    await createPhoto(seed.id, 1, { url: 'https://old1.jpg' })
  })

  const put = (id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/admin/users/${id}`, headers, payload: payload as any })
  const userRow = async () => (await sql`select * from users where id = ${seed.id}`)[0]
  const photoRows = () => sql`select url, position from user_photos where user_id = ${seed.id} order by position`

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'PUT', url: `/admin/users/${seed.id}`, payload: { name: 'X' } })
    expect(res.statusCode).toBe(401)
  })

  it('404s for an unknown user', async () => {
    const res = await put('00000000-0000-0000-0000-000000000000', { name: 'X' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('404s (not 500) for a malformed id', async () => {
    const res = await put('nope', { name: 'X' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('400s for a real (non-seed) user and leaves it untouched', async () => {
    const real = await createUser({ name: 'Real' })
    const res = await put(real.id, { name: 'X' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_a_seed_user' })
    expect((await sql`select name from users where id = ${real.id}`)[0].name).toBe('Real')
  })

  it.each([
    [{ name: '  ' }, 'invalid_name'],
    [{ age: 15 }, 'invalid_age'],
    [{ age: 25.5 }, 'invalid_age'],
    [{ gender: 'robot' }, 'invalid_gender'],
    [{ looking_for: 'aliens' }, 'invalid_looking_for'],
    [{ bio: 42 }, 'invalid_bio'],
    [{ location: [] }, 'invalid_location'],
    [{ interests: 'music' }, 'invalid_interests'],
    [{ interests: [1, 2] }, 'invalid_interests'],
    [{ is_active: 'yes' }, 'invalid_is_active'],
    [{ locale: 'de' }, 'invalid_locale'],
    [{ locale: null }, 'invalid_locale'],
    [{ photos: 'not-an-array' }, 'invalid_photos'],
    [{ photos: ['ok.jpg', ''] }, 'invalid_photos'],
    [{ photos: ['1', '2', '3', '4', '5', '6', '7'] }, 'too_many_photos'],
  ])('rejects invalid input %j', async (payload, error) => {
    const before = await userRow()
    const res = await put(seed.id, payload)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
    expect(await userRow()).toEqual(before)
    expect(await photoRows()).toHaveLength(2)
  })

  it('400s on an empty body', async () => {
    const res = await put(seed.id, {})
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_update' })
  })

  it('updates all provided fields, incl. is_active and null-cleared bio; clears geo on location change', async () => {
    const res = await put(seed.id, {
      name: '  Seed Sara  ',
      age: 27,
      gender: 'woman',
      looking_for: 'both',
      bio: null,
      location: 'Tehran',
      icebreaker_prompt: 'Ask me',
      icebreaker_answer: 'Anything',
      interests: ['music', 'travel'],
      is_active: false,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await userRow()).toMatchObject({
      name: 'Seed Sara',
      age: 27,
      gender: 'woman',
      looking_for: 'both',
      bio: null,
      location: 'Tehran',
      // A location change clears the hidden geo until it is re-resolved.
      geo_city: null,
      geo_country: null,
      icebreaker_prompt: 'Ask me',
      icebreaker_answer: 'Anything',
      interests: ['music', 'travel'],
      is_active: false,
    })
    expect(scheduleUserGeo).toHaveBeenCalledWith(seed.id, 'Tehran', expect.anything())
    // No photos in the body → photos untouched
    expect(await photoRows()).toHaveLength(2)
  })

  it('leaves omitted columns alone (no undefined → null wipe)', async () => {
    const res = await put(seed.id, { name: 'Only Name' })
    expect(res.statusCode).toBe(200)
    expect(await userRow()).toMatchObject({
      name: 'Only Name', bio: 'old bio', location: 'Shiraz', geo_city: 'Shiraz', interests: ['art'],
    })
    expect(scheduleUserGeo).not.toHaveBeenCalled()
  })

  it('updates the language a fake user messages in', async () => {
    const res = await put(seed.id, { locale: 'ar' })
    expect(res.statusCode).toBe(200)
    expect((await userRow()).locale).toBe('ar')
  })

  it('replaces photos with positions 0..n', async () => {
    const res = await put(seed.id, { photos: ['https://a.jpg', 'https://b.jpg', 'https://c.jpg'] })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await photoRows()).toEqual([
      { url: 'https://a.jpg', position: 0 },
      { url: 'https://b.jpg', position: 1 },
      { url: 'https://c.jpg', position: 2 },
    ])
  })

  it('photos-only update leaves the users row alone', async () => {
    const before = await userRow()
    const res = await put(seed.id, { photos: ['https://only.jpg'] })

    expect(res.statusCode).toBe(200)
    expect(await userRow()).toEqual(before)
    expect(await photoRows()).toEqual([{ url: 'https://only.jpg', position: 0 }])
  })

  it('photos: [] clears all photos', async () => {
    const res = await put(seed.id, { photos: [] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await photoRows()).toEqual([])
  })

  it('500s when the users update fails', async () => {
    const res = await withFailingWrite('users', 'update', () => put(seed.id, { name: 'X' }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
  })

  it('500s when the photo insert fails, keeping the old photos (delete+insert is one transaction)', async () => {
    const res = await withFailingWrite('user_photos', 'insert', () => put(seed.id, { photos: ['https://a.jpg'] }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photos_update_failed' })
    expect(await photoRows()).toHaveLength(2)
  })

  it('500s when the photo delete fails', async () => {
    const res = await withTableBroken('user_photos', () => put(seed.id, { photos: [] }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photos_update_failed' })
  })
})
