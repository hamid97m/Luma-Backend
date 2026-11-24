import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(), notifyFakePhotoWarning: vi.fn() }))

import { buildApp } from '../src/server.js'
import { parseApparentGender, checkMainPhoto } from '../src/moderation/photoAiCheck.js'
import { parseNameGender, checkProfileText, resetTextCheckUsage } from '../src/moderation/profileTextCheck.js'
import { getGenderFlag, countGenderFlags } from '../src/moderation/genderFlags.js'
import { resetDb, createUser, createPhoto, insertRow, sql } from './helpers/db.js'
import { seedPhotoFile } from './helpers/profile.js'
import { adminHeaders } from './helpers/admin.js'

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))

describe('parseApparentGender / parseNameGender', () => {
  it('keeps known values and nulls anything else', () => {
    expect(parseApparentGender('{"approved":true,"apparent_gender":"woman"}')).toBe('woman')
    expect(parseApparentGender('{"approved":true,"apparent_gender":"unclear"}')).toBe('unclear')
    expect(parseApparentGender('{"approved":true,"apparent_gender":"female"}')).toBeNull()
    expect(parseApparentGender('{"approved":true}')).toBeNull()
    expect(parseApparentGender('not json')).toBeNull()
    expect(parseNameGender('{"approved":true,"name_gender":"man"}', 'name')).toBe('man')
    expect(parseNameGender('{"approved":true,"name_gender":"unisex"}', 'name')).toBe('unisex')
    expect(parseNameGender('{"approved":true,"name_gender":"boy"}', 'name')).toBeNull()
    expect(parseNameGender('{"approved":true,"name_gender":"man"}', 'bio')).toBeNull()
    expect(parseNameGender('{', 'name')).toBeNull()
  })
})

describe('storing the guesses (never affects approval)', () => {
  const fetchMock = vi.fn()
  beforeEach(async () => {
    await resetDb()
    resetTextCheckUsage()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('stores apparent_gender on the photo check and still approves (no pause)', async () => {
    const u = await createUser({ gender: 'man', age: 27, telegram_id: 100 })
    const main = await createPhoto(u.id, 0)
    await seedPhotoFile(u.id, main.id)
    fetchMock.mockResolvedValueOnce(reply('{"approved":true,"reason":null,"apparent_gender":"woman"}'))
    expect(await checkMainPhoto(u.id)).toEqual({ approved: true, reason: null })
    const [row] = await sql`select apparent_gender, approved from photo_ai_checks where photo_id = ${main.id}`
    expect(row).toEqual({ apparent_gender: 'woman', approved: true })
    expect((await sql`select paused_at from users where id = ${u.id}`)[0].paused_at).toBeNull()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(60)
  })

  it('stores name_gender for the name field only', async () => {
    const u = await createUser()
    fetchMock.mockImplementation(async () => reply('{"approved":true,"reason":null,"name_gender":"woman"}'))
    expect(await checkProfileText(u.id, 'name', 'سارا')).toEqual({ approved: true, reason: null })
    await checkProfileText(u.id, 'bio', 'hello there')
    const rows = await sql`select field, name_gender from profile_text_checks order by field`
    expect(rows).toEqual([{ field: 'bio', name_gender: null }, { field: 'name', name_gender: 'woman' }])
  })
})

describe('gender flags', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const photoCheck = (userId: string, photoId: string, apparent_gender: string, created_at?: string) =>
    insertRow('photo_ai_checks', { photo_id: photoId, user_id: userId, approved: true, apparent_gender, ...(created_at ? { created_at } : {}) })
  const nameCheck = (userId: string, text: string, name_gender: string, created_at?: string) =>
    insertRow('profile_text_checks', {
      user_id: userId, field: 'name', text, approved: true, source: 'ai', name_gender, ...(created_at ? { created_at } : {}),
    })

  it('flags on the current main photo only', async () => {
    const u = await createUser({ gender: 'man' })
    const main = await createPhoto(u.id, 0)
    const second = await createPhoto(u.id, 1)
    await photoCheck(u.id, second.id, 'woman') // not the main photo
    expect(await getGenderFlag(u.id)).toBeNull()
    await photoCheck(u.id, main.id, 'woman')
    expect(await getGenderFlag(u.id)).toMatchObject({ photoGender: 'woman', nameGender: null, checkedAt: expect.anything() })
  })

  it('ignores matching or unclear guesses', async () => {
    const u = await createUser({ gender: 'woman', looking_for: 'men', name: 'Sara' })
    const main = await createPhoto(u.id, 0)
    await photoCheck(u.id, main.id, 'unclear')
    await nameCheck(u.id, 'Sara', 'woman')
    const v = await createUser({ gender: 'man', name: 'Kian' })
    await nameCheck(v.id, 'Kian', 'unisex')
    expect(await countGenderFlags()).toBe(0)
  })

  it('flags on the latest AI check of the current name only', async () => {
    const u = await createUser({ gender: 'man', name: 'Maryam' })
    await nameCheck(u.id, 'Ali', 'woman') // an old name
    expect(await getGenderFlag(u.id)).toBeNull()
    await nameCheck(u.id, 'Maryam', 'man', '2026-01-01T00:00:00Z')
    await nameCheck(u.id, 'Maryam', 'woman', '2026-02-01T00:00:00Z')
    expect(await getGenderFlag(u.id)).toMatchObject({ nameGender: 'woman' })
  })

  it('excludes seed, deleted and nonbinary users', async () => {
    for (const extra of [{ is_seed: true }, { deleted_at: '2026-01-01T00:00:00Z' }, { gender: 'nonbinary' }]) {
      const u = await createUser({ name: 'Maryam', ...extra })
      await nameCheck(u.id, 'Maryam', 'woman')
    }
    expect(await countGenderFlags()).toBe(0)
  })

  it('lists, counts and dismisses; newer evidence re-flags', async () => {
    const u = await createUser({ gender: 'man', name: 'Maryam', age: 30 })
    const main = await createPhoto(u.id, 0, { url: 'https://img/main' })
    await photoCheck(u.id, main.id, 'woman', '2026-03-01T00:00:00Z')
    await nameCheck(u.id, 'Maryam', 'woman', '2026-03-02T00:00:00Z')

    expect((await app.inject({ method: 'GET', url: '/admin/gender-flags/count', headers })).json()).toEqual({ count: 1 })
    const list = (await app.inject({ method: 'GET', url: '/admin/gender-flags', headers })).json()
    expect(list).toEqual({
      items: [{
        user: { id: u.id, name: 'Maryam', gender: 'man', age: 30, photoUrl: 'https://img/main', bannedAt: null, pausedAt: null },
        photoGender: 'woman', nameGender: 'woman', checkedAt: expect.any(String),
      }],
      total: 1, page: 1, pageCount: 1,
    })
    expect(new Date(list.items[0].checkedAt).toISOString()).toBe('2026-03-02T00:00:00.000Z')

    const detail = (await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })).json()
    expect(detail.genderFlag).toEqual({ photoGender: 'woman', nameGender: 'woman', checkedAt: expect.any(String) })

    const res = await app.inject({ method: 'POST', url: `/admin/gender-flags/${u.id}/dismiss`, headers })
    expect(res.json()).toEqual({ ok: true })
    expect((await app.inject({ method: 'GET', url: '/admin/gender-flags/count', headers })).json()).toEqual({ count: 0 })
    expect((await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })).json().genderFlag).toBeNull()

    // A new check after the dismissal flags again.
    await nameCheck(u.id, 'Maryam', 'woman')
    expect(await countGenderFlags()).toBe(1)

    expect((await app.inject({ method: 'POST', url: `/admin/gender-flags/${crypto.randomUUID()}/dismiss`, headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/admin/gender-flags' })).statusCode).toBe(401)
  })

  it('PUT /admin/users/:id/gender changes any user and dismisses the flag', async () => {
    const u = await createUser({ gender: 'man', name: 'Maryam', is_seed: false })
    await nameCheck(u.id, 'Maryam', 'woman')
    const res = await app.inject({ method: 'PUT', url: `/admin/users/${u.id}/gender`, headers, payload: { gender: 'woman' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, gender: 'woman' })
    const [row] = await sql`select gender, gender_review_dismissed_at from users where id = ${u.id}`
    expect(row.gender).toBe('woman')
    expect(row.gender_review_dismissed_at).not.toBeNull()
    expect(await countGenderFlags()).toBe(0)

    expect((await app.inject({ method: 'PUT', url: `/admin/users/${u.id}/gender`, headers, payload: { gender: 'x' } })).statusCode).toBe(400)
    const gone = await createUser({ deleted_at: '2026-01-01T00:00:00Z' })
    expect((await app.inject({ method: 'PUT', url: `/admin/users/${gone.id}/gender`, headers, payload: { gender: 'woman' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: '/admin/users/nope/gender', headers, payload: { gender: 'woman' } })).statusCode).toBe(404)
  })

  it('seed PUT /admin/users/:id with a gender also sets the dismissal', async () => {
    const s = await createUser({ is_seed: true, telegram_id: -5 })
    const res = await app.inject({ method: 'PUT', url: `/admin/users/${s.id}`, headers, payload: { gender: 'woman' } })
    expect(res.statusCode).toBe(200)
    expect((await sql`select gender_review_dismissed_at from users where id = ${s.id}`)[0].gender_review_dismissed_at).not.toBeNull()
  })
})
