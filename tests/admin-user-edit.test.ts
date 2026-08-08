import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const SEED_FETCH = { data: { id: 'u1', is_seed: true }, error: null }

function mockTables({
  fetch = SEED_FETCH,
  userUpdate = vi.fn(() => chainable({ error: null })),
  photoDelete = vi.fn(() => chainable({ error: null })),
  photoInsert = vi.fn(() => chainable({ error: null })),
} = {}) {
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return { select: () => chainable(fetch), update: userUpdate } as any
    if (table === 'user_photos') return { delete: photoDelete, insert: photoInsert } as any
    return chainable({ data: null })
  })
  return { userUpdate, photoDelete, photoInsert }
}

describe('PUT /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', payload: { name: 'X' } })
    expect(res.statusCode).toBe(401)
  })

  it('404s for an unknown user', async () => {
    mockTables({ fetch: { data: null, error: { message: 'not found' } } })
    const res = await app.inject({ method: 'PUT', url: '/admin/users/nope', headers, payload: { name: 'X' } })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('400s for a real (non-seed) user', async () => {
    const { userUpdate } = mockTables({ fetch: { data: { id: 'u1', is_seed: false }, error: null } })
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', headers, payload: { name: 'X' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_a_seed_user' })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it.each([
    [{ name: '  ' }, 'invalid_name'],
    [{ age: 15 }, 'invalid_age'],
    [{ age: 25.5 }, 'invalid_age'],
    [{ gender: 'robot' }, 'invalid_gender'],
    [{ looking_for: 'aliens' }, 'invalid_looking_for'],
    [{ bio: 42 }, 'invalid_bio'],
    [{ location: [] }, 'invalid_location'],
    [{ interests: 'music' }, 'invalid_interests'],
    [{ interests: [1, 2] }, 'invalid_interests'],
    [{ is_active: 'yes' }, 'invalid_is_active'],
    [{ photos: 'not-an-array' }, 'invalid_photos'],
    [{ photos: ['ok.jpg', ''] }, 'invalid_photos'],
    [{ photos: ['1', '2', '3', '4', '5', '6', '7'] }, 'too_many_photos'],
  ])('rejects invalid input %j', async (payload, error) => {
    const { userUpdate } = mockTables()
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', headers, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('400s on an empty body', async () => {
    const { userUpdate } = mockTables()
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', headers, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_update' })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('updates all provided fields with the exact patch, incl. is_active and null-cleared bio', async () => {
    const { userUpdate, photoDelete, photoInsert } = mockTables()
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/users/u1',
      headers,
      payload: {
        name: '  Seed Sara  ',
        age: 27,
        gender: 'woman',
        looking_for: 'men',
        bio: null,
        location: 'Tehran',
        icebreaker_prompt: 'Ask me',
        icebreaker_answer: 'Anything',
        interests: ['music', 'travel'],
        is_active: false,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(userUpdate).toHaveBeenCalledTimes(1)
    expect(userUpdate.mock.calls[0][0]).toEqual({
      name: 'Seed Sara',
      age: 27,
      gender: 'woman',
      looking_for: 'men',
      bio: null,
      location: 'Tehran',
      icebreaker_prompt: 'Ask me',
      icebreaker_answer: 'Anything',
      interests: ['music', 'travel'],
      is_active: false,
    })
    // No photos in the body → photos untouched
    expect(photoDelete).not.toHaveBeenCalled()
    expect(photoInsert).not.toHaveBeenCalled()
  })

  it('replaces photos: deletes existing rows then inserts with positions 0..n', async () => {
    const { photoDelete, photoInsert } = mockTables()
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/users/u1',
      headers,
      payload: { photos: ['https://a.jpg', 'https://b.jpg', 'https://c.jpg'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(photoDelete).toHaveBeenCalledTimes(1)
    expect(photoInsert).toHaveBeenCalledWith([
      { user_id: 'u1', url: 'https://a.jpg', position: 0 },
      { user_id: 'u1', url: 'https://b.jpg', position: 1 },
      { user_id: 'u1', url: 'https://c.jpg', position: 2 },
    ])
    expect(photoDelete.mock.invocationCallOrder[0]).toBeLessThan(photoInsert.mock.invocationCallOrder[0])
  })

  it('photos-only update skips users.update entirely', async () => {
    const { userUpdate, photoDelete, photoInsert } = mockTables()
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/users/u1',
      headers,
      payload: { photos: ['https://only.jpg'] },
    })

    expect(res.statusCode).toBe(200)
    expect(userUpdate).not.toHaveBeenCalled()
    expect(photoDelete).toHaveBeenCalledTimes(1)
    expect(photoInsert).toHaveBeenCalledTimes(1)
  })

  it('photos: [] clears all photos without inserting', async () => {
    const { userUpdate, photoDelete, photoInsert } = mockTables()
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', headers, payload: { photos: [] } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(userUpdate).not.toHaveBeenCalled()
    expect(photoDelete).toHaveBeenCalledTimes(1)
    expect(photoInsert).not.toHaveBeenCalled()
  })

  it('500s when the users update fails', async () => {
    mockTables({ userUpdate: vi.fn(() => chainable({ error: { message: 'db down' } })) })
    const res = await app.inject({ method: 'PUT', url: '/admin/users/u1', headers, payload: { name: 'X' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
  })

  it('500s when the photo replacement fails', async () => {
    mockTables({ photoInsert: vi.fn(() => chainable({ error: { message: 'db down' } })) })
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/users/u1',
      headers,
      payload: { photos: ['https://a.jpg'] },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'photos_update_failed' })
  })
})
