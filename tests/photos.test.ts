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
      method: 'POST', url: '/profile/me/photos/upload-url',
      headers: AUTH, payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('returns uploadUrl and photoId (no publicUrl, no pre-insert) on success', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'p1' }], error: null }) }),
    } as any)

    const SIGNED_URL = 'https://supabase.example.com/signed-upload-url'
    vi.mocked(db.storage.from).mockReturnValue({
      createSignedUploadUrl: () => Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/upload-url',
      headers: AUTH, payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('uploadUrl', SIGNED_URL)
    expect(body).toHaveProperty('photoId')
    expect(body).not.toHaveProperty('publicUrl')
  })
})

describe('POST /profile/me/photos/confirm', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 400 when user already has 6 photos', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: new Array(6).fill({ id: 'x' }), error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: 'some-uuid' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'max_photos_reached' })
  })

  it('returns 409 when photoId already confirmed', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'existing-uuid' }], error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: 'existing-uuid' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'photo_already_confirmed' })
  })

  it('inserts photo row and returns photo object', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'old-photo' }], error: null }) }),
    } as any)

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({ data: null, error: null }),
    } as any)

    // Resume check: user was not paused, so the .not() guard yields no row.
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }) }),
    } as any)

    const PUBLIC_URL = 'https://supabase.example.com/public/profile-photos/user-uuid-1/new-uuid'
    vi.mocked(db.storage.from).mockReturnValue({
      getPublicUrl: () => ({ data: { publicUrl: PUBLIC_URL } }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: 'new-uuid' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      photo: { id: 'new-uuid', url: PUBLIC_URL, position: 1 },
    })
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
      method: 'DELETE', url: '/profile/me/photos/nonexistent', headers: AUTH,
    })

    expect(res.statusCode).toBe(404)
  })

  it('removes file from Supabase Storage and compacts positions', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: { id: 'photo-1', position: 1 }, error: null }) }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)

    const storageMock = { remove: vi.fn().mockResolvedValue({ error: null }) }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ gt: () => ({ data: [{ id: 'photo-2', position: 2 }], error: null }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'DELETE', url: '/profile/me/photos/photo-1', headers: AUTH,
    })

    expect(res.statusCode).toBe(200)
    expect(storageMock.remove).toHaveBeenCalledWith([`${USER_ID}/photo-1`])
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('PATCH /profile/me/photos/reorder', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns ok:true after reordering photos', async () => {
    setupAuth()
    const photoIds = ['photo-b', 'photo-a', 'photo-c']

    // Two passes over the ids: stage to negative positions, then to final ones.
    for (let i = 0; i < photoIds.length * 2; i++) {
      vi.mocked(db.from).mockReturnValueOnce({
        update: () => ({ eq: () => ({ eq: () => ({ data: null, error: null }) }) }),
      } as any)
    }

    const res = await app.inject({
      method: 'PATCH', url: '/profile/me/photos/reorder',
      headers: AUTH, payload: { order: photoIds },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 500 instead of silently swallowing a failed position update', async () => {
    setupAuth()
    const photoIds = ['photo-b', 'photo-a', 'photo-c']

    // First staging update hits the UNIQUE(user_id, position) constraint.
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ eq: () => ({ data: null, error: { code: '23505' } }) }) }),
    } as any)

    const res = await app.inject({
      method: 'PATCH', url: '/profile/me/photos/reorder',
      headers: AUTH, payload: { order: photoIds },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'reorder_failed' })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/profile/me/photos/reorder' })
    expect(res.statusCode).toBe(401)
  })
})
