import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const VALID_BODY = {
  name: 'Seed Sara', age: 25, gender: 'woman', looking_for: 'men',
  bio: 'hello', interests: ['music'], location: 'Tehran',
  photos: ['https://p1.jpg', 'https://p2.jpg'],
}

describe('POST /admin/users', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('creates a seed user with negative telegram_id and inserts photos', async () => {
    const userInsert = vi.fn(() => chainable({ data: { id: 'new-1' }, error: null }))
    const photoInsert = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'users' ? ({ insert: userInsert } as any) : ({ insert: photoInsert } as any)
    )

    const res = await app.inject({ method: 'POST', url: '/admin/users', headers, payload: VALID_BODY })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'new-1' })

    const inserted = userInsert.mock.calls[0][0] as any
    expect(inserted.telegram_id).toBeLessThan(0)
    expect(inserted.is_seed).toBe(true)
    expect(inserted.is_active).toBe(true)
    expect(inserted.name).toBe('Seed Sara')

    expect(photoInsert).toHaveBeenCalledWith([
      { user_id: 'new-1', url: 'https://p1.jpg', position: 0 },
      { user_id: 'new-1', url: 'https://p2.jpg', position: 1 },
    ])
  })

  it.each([
    [{ ...VALID_BODY, name: '  ' }, 'invalid_name'],
    [{ ...VALID_BODY, age: 15 }, 'invalid_age'],
    [{ ...VALID_BODY, gender: 'robot' }, 'invalid_gender'],
    [{ ...VALID_BODY, looking_for: 'aliens' }, 'invalid_looking_for'],
  ])('rejects invalid input %#', async (payload, error) => {
    const res = await app.inject({ method: 'POST', url: '/admin/users', headers, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
  })
})
