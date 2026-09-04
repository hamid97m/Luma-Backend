import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

// Queue the auth middleware's user lookup as the next db.from() call.
function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /profile/me/photos/upload-url (replace bypasses cap)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.mocked(db.from).mockReset()
    app = await buildApp()
  })

  it('allows the request at 6 photos when replacePhotoId matches an owned photo', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'p1' }, ...new Array(5).fill({ id: 'x' })], error: null }) }),
    } as any)

    const SIGNED_URL = 'https://supabase.example.com/signed-upload-url'
    vi.mocked(db.storage.from).mockReturnValue({
      createSignedUploadUrl: () => Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/upload-url',
      headers: AUTH, payload: { contentType: 'image/jpeg', replacePhotoId: 'p1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('uploadUrl', SIGNED_URL)
  })

  it('still returns 400 at 6 photos when replacePhotoId is not owned', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: new Array(6).fill({ id: 'x' }), error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/upload-url',
      headers: AUTH, payload: { contentType: 'image/jpeg', replacePhotoId: 'not-mine' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })
})

describe('POST /profile/me/photos/:photoId/replace', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.mocked(db.from).mockReset()
    app = await buildApp()
  })

  it('returns 404 when the old photo is not found', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: { code: 'PGRST116' } }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/old-photo/replace',
      headers: AUTH, payload: { newPhotoId: 'new-photo' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'photo_not_found' })
  })

  it('returns 400 when newPhotoId equals the old id', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/old-photo/replace',
      headers: AUTH, payload: { newPhotoId: 'old-photo' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_photo_id' })
  })

  it('swaps the new photo into the old photo position and returns it', async () => {
    setupAuth()

    // Old photo lookup.
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: { id: 'old-photo', position: 2 }, error: null }) }) }) }),
    } as any)
    // Delete old row.
    vi.mocked(db.from).mockReturnValueOnce({
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)
    // Insert new row.
    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({ data: null, error: null }),
    } as any)
    // Resume check: not paused → no row.
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }) }),
    } as any)

    const PUBLIC_URL = 'https://supabase.example.com/public/profile-photos/user-uuid-1/new-photo'
    const storageMock = {
      remove: vi.fn().mockResolvedValue({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: PUBLIC_URL } }),
    }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/old-photo/replace',
      headers: AUTH, payload: { newPhotoId: 'new-photo' },
    })

    expect(res.statusCode).toBe(200)
    expect(storageMock.remove).toHaveBeenCalledWith([`${USER_ID}/old-photo`])
    expect(res.json()).toEqual({ photo: { id: 'new-photo', url: PUBLIC_URL, position: 2 } })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/old-photo/replace',
      payload: { newPhotoId: 'new-photo' },
    })
    expect(res.statusCode).toBe(401)
  })
})
