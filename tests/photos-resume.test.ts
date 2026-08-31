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
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ data: [] }) }) } as any)  // existing photos count
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
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ data: [] }) }) } as any)
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
})
