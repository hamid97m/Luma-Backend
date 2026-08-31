import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const PHOTO_ID = '11111111-1111-1111-1111-111111111111'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: 'me-1' } }) }) }),
  } as any)
}

describe('POST /profile/me/photos/confirm — resume', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
    ;(db.storage.from as any) = vi.fn(() => ({
      getPublicUrl: () => ({ data: { publicUrl: 'https://cdn/me-1/photo.jpg' } }),
    }))
  })

  it('clears the pause and resolves pending reports when the user was paused', async () => {
    setupAuth()
    const usersUpdate = vi.fn(() => ({
      eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: { id: 'me-1' } }) }) }) }),
    }))
    const reportsUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ order: () => ({ data: [] }) }) }) } as any)  // existing photos count
      .mockReturnValueOnce({ insert: () => ({ error: null }) } as any)               // insert photo
      .mockReturnValueOnce({ update: usersUpdate } as any)                            // clear paused_at
      .mockReturnValueOnce({ update: reportsUpdate } as any)                          // resolve reports

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH,
      payload: { photoId: PHOTO_ID },
    })
    expect(res.statusCode).toBe(200)
    expect((usersUpdate.mock.calls[0][0] as any).paused_at).toBeNull()
    expect((reportsUpdate.mock.calls[0][0] as any).status).toBe('resolved_reuploaded')
  })

  it('does not touch reports when the user was not paused', async () => {
    setupAuth()
    const usersUpdate = vi.fn(() => ({
      eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }),
    }))
    const reportsUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ order: () => ({ data: [] }) }) }) } as any)
      .mockReturnValueOnce({ insert: () => ({ error: null }) } as any)
      .mockReturnValueOnce({ update: usersUpdate } as any)
      .mockReturnValueOnce({ update: reportsUpdate } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH,
      payload: { photoId: PHOTO_ID },
    })
    expect(res.statusCode).toBe(200)
    expect(reportsUpdate).not.toHaveBeenCalled()
  })

  it('evicts the oldest photo to let a paused user at the cap self-resume', async () => {
    // The previous test's reportsUpdate mockReturnValueOnce is never consumed
    // when `resumed` is falsy, and vi.clearAllMocks() (beforeEach) does not
    // drain queued once-implementations — reset explicitly to start clean.
    vi.mocked(db.from).mockReset()
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    // Auth preHandler: user row carries a non-null paused_at, so req.isPaused === true.
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { id: 'me-1', paused_at: '2026-08-31T00:00:00Z' } }) }) }),
    } as any)

    const oldest = { id: 'oldest-photo', position: 0 }
    const existingPhotos = [
      oldest,
      { id: 'p2', position: 1 },
      { id: 'p3', position: 2 },
      { id: 'p4', position: 3 },
      { id: 'p5', position: 4 },
      { id: 'p6', position: 5 },
    ]

    const deleteEq = vi.fn(() => ({ error: null }))
    const insert = vi.fn(() => ({ error: null }))
    const usersUpdate = vi.fn(() => ({
      eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: { id: 'me-1' } }) }) }) }),
    }))
    const reportsUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }))
    const storageRemove = vi.fn().mockResolvedValue({ error: null })
    ;(db.storage.from as any) = vi.fn(() => ({
      getPublicUrl: () => ({ data: { publicUrl: 'https://cdn/me-1/photo.jpg' } }),
      remove: storageRemove,
    }))

    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ order: () => ({ data: existingPhotos }) }) }) } as any) // existing photos, at cap
      .mockReturnValueOnce({ delete: () => ({ eq: deleteEq }) } as any)                                            // evict oldest photo
      .mockReturnValueOnce({ insert } as any)                                                                      // insert new photo
      .mockReturnValueOnce({ update: usersUpdate } as any)                                                          // clear paused_at
      .mockReturnValueOnce({ update: reportsUpdate } as any)                                                        // resolve reports

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm', headers: AUTH,
      payload: { photoId: PHOTO_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(deleteEq).toHaveBeenCalledWith('id', oldest.id)
    expect(storageRemove).toHaveBeenCalledWith([`me-1/${oldest.id}`])
    expect(insert.mock.calls[0][0]).toMatchObject({ id: PHOTO_ID, position: oldest.position })
    expect(res.json()).toEqual({
      photo: { id: PHOTO_ID, url: 'https://cdn/me-1/photo.jpg', position: oldest.position },
    })
    expect((usersUpdate.mock.calls[0][0] as any).paused_at).toBeNull()
    expect((reportsUpdate.mock.calls[0][0] as any).status).toBe('resolved_reuploaded')
  })
})
