import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const TG_USER = { id: 1, first_name: 'Ali' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue(TG_USER as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /profile/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns full profile with photos', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        select: () => ({
          eq: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null }, error: null }) }),
        }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({
          eq: () => ({ order: () => ({ data: [{ id: 'p1', url: 'https://img', position: 0 }], error: null }) }),
        }),
      } as any)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Ali',
      age: 25,
      photos: [{ id: 'p1', position: 0 }],
      setupComplete: true,
    })
  })
})

describe('PUT /profile/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('updates bio and returns updated profile', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: 'سلام' }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { bio: 'سلام' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().bio).toBe('سلام')
  })

  it('rejects a numeric name with 400 invalid_name', async () => {
    setupAuth()

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { name: '12345' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_name' })
  })

  it('rejects a Persian-digit name with 400 invalid_name', async () => {
    setupAuth()

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { name: '۱۲۳' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_name' })
  })

  it('accepts and trims a valid name', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { name: '  Ali  ' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Ali')
  })

  it('pauses the account by setting is_active to false', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null, is_active: false }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { is_active: false },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().is_active).toBe(false)
  })
})

describe('DELETE /profile/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('removes photos from storage and wipes the profile', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'photo-1' }, { id: 'photo-2' }], error: null }) }),
    } as any)

    const storageMock = { remove: vi.fn().mockResolvedValue({ error: null }) }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    vi.mocked(db.from).mockReturnValueOnce({
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    } as any)

    const updateMock = vi.fn().mockReturnValue({ eq: () => ({ data: null, error: null }) })
    vi.mocked(db.from).mockReturnValueOnce({ update: updateMock } as any)

    const res = await app.inject({ method: 'DELETE', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(storageMock.remove).toHaveBeenCalledWith([`${USER_ID}/photo-1`, `${USER_ID}/photo-2`])
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      name: '', bio: null, interests: [], location: null,
      icebreaker_prompt: null, icebreaker_answer: null,
      age: 0, is_active: false,
    }))
    expect(updateMock.mock.calls[0][0].deleted_at).toEqual(expect.any(String))
  })

  it('skips storage cleanup when the user has no photos', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [], error: null }) }),
    } as any)

    const updateMock = vi.fn().mockReturnValue({ eq: () => ({ data: null, error: null }) })
    vi.mocked(db.from).mockReturnValueOnce({ update: updateMock } as any)

    const res = await app.inject({ method: 'DELETE', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/profile/me' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 500 when photo deletion fails', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ data: [{ id: 'photo-1' }], error: null }) }),
    } as any)

    const storageMock = { remove: vi.fn().mockResolvedValue({ error: null }) }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    vi.mocked(db.from).mockReturnValueOnce({
      delete: () => ({ eq: () => ({ data: null, error: { message: 'DB error' } }) }),
    } as any)

    const res = await app.inject({ method: 'DELETE', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'delete_failed' })
  })
})

describe('preHandler — deleted account gate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 401 account_deleted for a soft-deleted user on a protected route', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID, deleted_at: '2026-08-01T00:00:00Z' } }) }) }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_deleted' })
  })
})
