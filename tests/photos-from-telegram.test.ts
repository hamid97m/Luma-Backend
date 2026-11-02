import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ fetchTelegramProfilePhoto: vi.fn(), getBotUsername: () => null }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { buildApp } from '../src/server.js'
import { readFile, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchTelegramProfilePhoto } from '../src/bot.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { PHOTO_URL_BASE, createReport, photoFile, photoFileExists, seedPhotoFile } from './helpers/profile.js'

describe('POST /profile/me/photos/from-telegram', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    app = await buildApp()
  })

  const importPhoto = () => app.inject({ method: 'POST', url: '/profile/me/photos/from-telegram', headers: AUTH })

  it('imports the Telegram photo → 200 and inserts a user_photos row at position 0', async () => {
    const me = await createUser({ telegram_id: 42 })
    authAs(me)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({ buffer: Buffer.from('jpegbytes'), mime: 'image/jpeg' })

    const res = await importPhoto()

    expect(res.statusCode).toBe(200)
    expect(fetchTelegramProfilePhoto).toHaveBeenCalledWith(42)
    const [row] = await sql`select id, user_id, url, position from user_photos`
    const url = `${PHOTO_URL_BASE}/${me.id}/${row.id}`
    expect(row).toMatchObject({ user_id: me.id, url, position: 0 })
    expect(await readFile(photoFile(me.id, row.id), 'utf8')).toBe('jpegbytes')
    expect(res.json()).toEqual({ photo: { id: row.id, url, position: 0 } })
    // The returned URL is actually served.
    const served = await app.inject({ method: 'GET', url: url.replace('http://api.test', '') })
    expect(served.statusCode).toBe(200)
    expect(served.rawPayload.toString()).toBe('jpegbytes')
  })

  it('returns 500 upload_failed and inserts no row when the file cannot be written', async () => {
    const me = await createUser({ telegram_id: 42 })
    authAs(me)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({ buffer: Buffer.from('jpegbytes'), mime: 'image/jpeg' })
    const userDir = join(process.env.MEDIA_DIR!, 'public', 'profile-photos', me.id)
    await mkdir(userDir, { recursive: true })
    await chmod(userDir, 0o500) // read-only: the write fails with EACCES
    try {
      const res = await importPhoto()
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'upload_failed' })
    } finally {
      await chmod(userDir, 0o700)
    }
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
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
    await seedPhotoFile(me.id, photos[0].id)
    await createReport(me.id)
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({ buffer: Buffer.from('x'), mime: 'image/jpeg' })

    const res = await importPhoto()

    expect(res.statusCode).toBe(200)
    expect(res.json().photo.position).toBe(0)
    expect(photoFileExists(me.id, photos[0].id)).toBe(false)
    expect((await sql`select paused_at from users where id = ${me.id}`)[0].paused_at).toBeNull()
    expect((await sql`select status from reports`)[0].status).toBe('resolved_reuploaded')
  })
})
