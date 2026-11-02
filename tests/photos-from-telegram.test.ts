import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// Storage still goes through supabase-js; the DB part is real Postgres.
vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ fetchTelegramProfilePhoto: vi.fn(), getBotUsername: () => null }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { fetchTelegramProfilePhoto } from '../src/bot.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { storageMock, createReport } from './helpers/profile.js'

describe('POST /profile/me/photos/from-telegram', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let storage: ReturnType<typeof storageMock>
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    app = await buildApp()
    storage = storageMock(() => 'https://cdn/me-1/tg.jpg')
    vi.mocked(db.storage.from).mockReturnValue(storage as any)
  })

  const importPhoto = () => app.inject({ method: 'POST', url: '/profile/me/photos/from-telegram', headers: AUTH })

  it('imports the Telegram photo → 200 and inserts a user_photos row at position 0', async () => {
    const me = await createUser({ telegram_id: 42 })
    authAs(me)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({ buffer: Buffer.from('jpegbytes'), mime: 'image/jpeg' })

    const res = await importPhoto()

    expect(res.statusCode).toBe(200)
    expect(fetchTelegramProfilePhoto).toHaveBeenCalledWith(42)
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(storage.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/jpeg', upsert: true })
    const [row] = await sql`select id, user_id, url, position from user_photos`
    expect(row).toMatchObject({ user_id: me.id, url: 'https://cdn/me-1/tg.jpg', position: 0 })
    expect(storage.upload.mock.calls[0][0]).toBe(`${me.id}/${row.id}`)
    expect(res.json()).toEqual({ photo: { id: row.id, url: 'https://cdn/me-1/tg.jpg', position: 0 } })
  })

  it('returns 409 no_telegram_photo when the user has no Telegram profile photo', async () => {
    const me = await createUser({ telegram_id: 42 })
    authAs(me)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue(null)

    const res = await importPhoto()

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'no_telegram_photo' })
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
  })

  it('returns 409 no_telegram_photo for a non-positive telegram_id (seed account)', async () => {
    const me = await createUser({ telegram_id: -7 })
    authAs(me)

    const res = await importPhoto()

    expect(res.statusCode).toBe(409)
    expect(fetchTelegramProfilePhoto).not.toHaveBeenCalled()
  })

  it('returns 400 at the photo cap for an active user', async () => {
    const me = await createUser({ telegram_id: 42 })
    authAs(me)
    for (let i = 0; i < 6; i++) await createPhoto(me.id, i)

    const res = await importPhoto()

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('lets a paused user at the cap evict the oldest photo and lifts the pause', async () => {
    const me = await createUser({ telegram_id: 42, paused_at: '2026-08-31T00:00:00Z' })
    authAs(me)
    const photos = []
    for (let i = 0; i < 6; i++) photos.push(await createPhoto(me.id, i))
    await createReport(me.id)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({ buffer: Buffer.from('x'), mime: 'image/jpeg' })

    const res = await importPhoto()

    expect(res.statusCode).toBe(200)
    expect(res.json().photo.position).toBe(0)
    expect(storage.remove).toHaveBeenCalledWith([`${me.id}/${photos[0].id}`])
    expect((await sql`select paused_at from users where id = ${me.id}`)[0].paused_at).toBeNull()
    expect((await sql`select status from reports`)[0].status).toBe('resolved_reuploaded')
  })
})
