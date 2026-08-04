import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const MATCH_ROW = {
  id: 'm1', created_at: '2026-08-02T00:00:00Z', user1_id: 'u1', user2_id: 'u2',
  user1: { id: 'u1', name: 'Sara', user_photos: [{ url: 'https://s.jpg', position: 0 }] },
  user2: { id: 'u2', name: 'Ali', user_photos: [] },
}

function mockTables(results: Record<string, unknown>) {
  vi.mocked(db.from).mockImplementation((table: string) => chainable(results[table]))
}

describe('admin chats', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('GET /admin/chats lists matches with participants and last message', async () => {
    mockTables({
      matches: { data: [MATCH_ROW], count: 1, error: null },
      messages: { count: 4, data: [{ body: 'hey', created_at: '2026-08-03T00:00:00Z' }], error: null },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/chats', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0]).toEqual({
      matchId: 'm1',
      matchedAt: '2026-08-02T00:00:00Z',
      users: [
        { id: 'u1', name: 'Sara', photo: 'https://s.jpg' },
        { id: 'u2', name: 'Ali', photo: null },
      ],
      messageCount: 4,
      lastMessage: { body: 'hey', createdAt: '2026-08-03T00:00:00Z' },
    })
  })

  it('GET /admin/chats/:matchId returns participants and paginated transcript', async () => {
    mockTables({
      matches: { data: MATCH_ROW, error: null },
      messages: {
        count: 1,
        data: [{ id: 'msg1', sender_id: 'u1', body: 'hi', created_at: '2026-08-03T00:00:00Z', read_at: null }],
        error: null,
      },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/chats/m1', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.match.id).toBe('m1')
    expect(body.match.users).toHaveLength(2)
    expect(body.messages.items).toEqual([
      { id: 'msg1', senderId: 'u1', body: 'hi', createdAt: '2026-08-03T00:00:00Z', readAt: null },
    ])
    expect(body.messages.pageCount).toBe(1)
  })

  it('returns 404 for an unknown match', async () => {
    mockTables({ matches: { data: null, error: { message: 'not found' } } })
    const res = await app.inject({ method: 'GET', url: '/admin/chats/nope', headers })
    expect(res.statusCode).toBe(404)
  })
})
