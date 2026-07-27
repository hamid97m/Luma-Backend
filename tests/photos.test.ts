import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /profile/me/photos/upload-url', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 400 when user already has 6 photos', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: new Array(6).fill({ id: 'x' }), error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/profile/me/photos/upload-url',
      headers: AUTH,
      payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('returns uploadUrl, publicUrl, and photoId on success', async () => {
    setupAuth()

    // existing photos query — fewer than 6
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'p1' }], error: null }) }),
    } as any)

    // insert new photo row
    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({ data: null, error: null }),
    } as any)

    const SIGNED_URL = 'https://supabase.example.com/signed-upload-url'
    const PUBLIC_URL = 'https://supabase.example.com/public/profile-photos/user-uuid-1/some-uuid'

    vi.mocked(db.storage.from).mockReturnValue({
      createSignedUploadUrl: () => Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: PUBLIC_URL } }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/profile/me/photos/upload-url',
      headers: AUTH,
      payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('uploadUrl')
    expect(body).toHaveProperty('publicUrl')
    expect(body).toHaveProperty('photoId')
  })
})

describe('DELETE /profile/me/photos/:photoId', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 404 when photo not found', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: { code: 'PGRST116' } }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'DELETE',
      url: '/profile/me/photos/nonexistent',
      headers: AUTH,
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns ok:true and compacts positions after delete', async () => {
    setupAuth()

    // fetch the photo to delete (position 1)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => ({ data: { id: 'photo-1', position: 1 }, error: null }),
          }),
        }),
      }),
    } as any)

    // delete the photo
    vi.mocked(db.from).mockReturnValueOnce({
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)

    // fetch remaining photos above deleted position
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          gt: () => ({ data: [{ id: 'photo-2', position: 2 }], error: null }),
        }),
      }),
    } as any)

    // update position for remaining photos
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'DELETE',
      url: '/profile/me/photos/photo-1',
      headers: AUTH,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('PATCH /profile/me/photos/reorder', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns ok:true after reordering photos', async () => {
    setupAuth()

    const photoIds = ['photo-b', 'photo-a', 'photo-c']

    // mock one db.from call per photo in the order array
    for (let i = 0; i < photoIds.length; i++) {
      vi.mocked(db.from).mockReturnValueOnce({
        update: () => ({
          eq: () => ({
            eq: () => ({ data: null, error: null }),
          }),
        }),
      } as any)
    }

    const res = await app.inject({
      method: 'PATCH',
      url: '/profile/me/photos/reorder',
      headers: AUTH,
      payload: { order: photoIds },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/profile/me/photos/reorder',
      // no auth header
    })

    expect(res.statusCode).toBe(401)
  })
})
