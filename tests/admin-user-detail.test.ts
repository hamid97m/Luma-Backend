import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const USER_ROW = {
  id: 'u1', telegram_id: 42, username: 'sara', name: 'Sara', age: 24,
  gender: 'woman', looking_for: 'men', bio: 'hi', interests: ['music'],
  location: 'Tehran', icebreaker_prompt: null, icebreaker_answer: null,
  allows_write_to_pm: true, is_active: true, is_seed: false, banned_at: null,
  deleted_at: null, created_at: '2026-08-01T00:00:00Z', last_active: '2026-08-04T00:00:00Z',
}

const MATCH_ROW = {
  id: 'm1', created_at: '2026-08-02T00:00:00Z', user1_id: 'u1', user2_id: 'u2',
  user1: { id: 'u1', name: 'Sara', user_photos: [] },
  user2: { id: 'u2', name: 'Ali', user_photos: [{ url: 'https://a.jpg', position: 0 }] },
}

function mockTables(results: Record<string, unknown>) {
  vi.mocked(db.from).mockImplementation((table: string) => chainable(results[table]))
}

describe('GET /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('returns profile, counts, and matches with the other user resolved', async () => {
    mockTables({
      users: { data: USER_ROW, error: null },
      user_photos: { data: [{ url: 'https://p1.jpg', position: 0 }], error: null },
      swipes: { count: 7, error: null },
      messages: { count: 3, error: null },
      matches: { data: [MATCH_ROW], error: null },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/users/u1', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user.name).toBe('Sara')
    expect(body.user.lookingFor).toBe('men')
    expect(body.user.photos).toEqual(['https://p1.jpg'])
    expect(body.counts).toEqual({ swipesGiven: 7, likesReceived: 7, matches: 1, messagesSent: 3 })
    expect(body.matches).toEqual([
      { matchId: 'm1', matchedAt: '2026-08-02T00:00:00Z', user: { id: 'u2', name: 'Ali', photo: 'https://a.jpg' } },
    ])
  })

  it('returns 404 for an unknown user', async () => {
    mockTables({ users: { data: null, error: { message: 'not found' } } })
    const res = await app.inject({ method: 'GET', url: '/admin/users/nope', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('returns 500 when a sub-query fails', async () => {
    mockTables({
      users: { data: USER_ROW, error: null },
      user_photos: { data: null, error: { message: 'boom' } },
      swipes: { count: 0, error: null },
      messages: { count: 0, error: null },
      matches: { data: [], error: null },
    })
    const res = await app.inject({ method: 'GET', url: '/admin/users/u1', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'user_detail_fetch_failed' })
  })
})
