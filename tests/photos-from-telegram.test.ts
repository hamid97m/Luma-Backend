import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ fetchTelegramProfilePhoto: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { fetchTelegramProfilePhoto } from '../src/bot.js'

const AUTH = { authorization: 'valid_init_data' }

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  // Auth preHandler: resolve telegram_id → user row (no paused_at → not paused).
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: 'me-1' } }) }) }),
  } as any)
}

describe('POST /profile/me/photos/from-telegram', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('imports the Telegram photo → 200 and inserts a user_photos row at position 0', async () => {
    setupAuth()
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue({
      buffer: Buffer.from('jpegbytes'),
      mime: 'image/jpeg',
    })

    const upload = vi.fn().mockResolvedValue({ error: null })
    ;(db.storage.from as any) = vi.fn(() => ({
      upload,
      getPublicUrl: () => ({ data: { publicUrl: 'https://cdn/me-1/tg.jpg' } }),
    }))

    const insert = vi.fn(() => ({ error: null }))
    const usersUpdate = vi.fn(() => ({
      eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }),
    }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { telegram_id: 42 } }) }) }) } as any) // lookup telegram_id
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ order: () => ({ data: [] }) }) }) } as any)                     // existing photos count
      .mockReturnValueOnce({ insert } as any)                                                                             // insert photo
      .mockReturnValueOnce({ update: usersUpdate } as any)                                                                // clear paused_at

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/from-telegram', headers: AUTH,
    })

    expect(res.statusCode).toBe(200)
    expect(fetchTelegramProfilePhoto).toHaveBeenCalledWith(42)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/jpeg', upsert: true })
    const inserted = insert.mock.calls[0][0] as any
    expect(inserted).toMatchObject({ user_id: 'me-1', url: 'https://cdn/me-1/tg.jpg', position: 0 })
    expect(res.json()).toEqual({
      photo: { id: inserted.id, url: 'https://cdn/me-1/tg.jpg', position: 0 },
    })
  })

  it('returns 409 no_telegram_photo when the user has no Telegram profile photo', async () => {
    setupAuth()
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValue(null)

    const insert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { telegram_id: 42 } }) }) }) } as any) // lookup telegram_id
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ order: () => ({ data: [] }) }) }) } as any)                     // existing photos count
      .mockReturnValueOnce({ insert } as any)                                                                             // must NOT be reached

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/from-telegram', headers: AUTH,
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'no_telegram_photo' })
    expect(insert).not.toHaveBeenCalled()
  })
})
