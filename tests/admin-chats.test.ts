import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

const RECENT = new Date().toISOString()

const MATCH_ROW = {
  id: 'm1', created_at: '2026-08-02T00:00:00Z', user1_id: 'u1', user2_id: 'u2',
  user1: { id: 'u1', name: 'Sara', user_photos: [{ url: 'https://s.jpg', position: 0 }] },
  user2: { id: 'u2', name: 'Ali', user_photos: [] },
}

// A fake (seed) chat: user1 is the seed, user2 is a real, online user (so
// deliverMessageNotification's offline-gate short-circuits and never touches
// the db further in these tests).
const FAKE_MATCH_ROW = {
  id: 'm1', created_at: '2026-08-05T00:00:00Z', user1_id: 'seed1', user2_id: 'real1',
  user1: {
    id: 'seed1', name: 'Fake Sara', is_seed: true, telegram_id: null,
    last_active: null, notified_offline_at: null, allows_write_to_pm: null, user_photos: [],
  },
  user2: {
    id: 'real1', name: 'Ali', is_seed: false, telegram_id: 999,
    last_active: RECENT, notified_offline_at: null, allows_write_to_pm: null, user_photos: [],
  },
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
        { id: 'u1', name: 'Sara', photo: 'https://s.jpg', isSeed: false },
        { id: 'u2', name: 'Ali', photo: null, isSeed: false },
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
    mockTables({ matches: { data: null, error: { code: 'PGRST116', message: 'not found' } } })
    const res = await app.inject({ method: 'GET', url: '/admin/chats/nope', headers })
    expect(res.statusCode).toBe(404)
  })

  it('returns 500 when a chats sub-query fails', async () => {
    mockTables({
      matches: { data: [MATCH_ROW], count: 1, error: null },
      messages: { count: null, data: null, error: { message: 'boom' } },
    })
    const res = await app.inject({ method: 'GET', url: '/admin/chats', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'chats_fetch_failed' })
  })

  it('returns 500 (not 404) when the match lookup fails with a real DB error', async () => {
    mockTables({ matches: { data: null, error: { code: '57014', message: 'timeout' } } })
    const res = await app.inject({ method: 'GET', url: '/admin/chats/m1', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'chats_fetch_failed' })
  })

  it('returns 500 when the transcript messages query fails', async () => {
    mockTables({
      matches: { data: MATCH_ROW, error: null },
      messages: { count: null, data: null, error: { message: 'boom' } },
    })
    const res = await app.inject({ method: 'GET', url: '/admin/chats/m1', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'messages_fetch_failed' })
  })

  it('GET /admin/chats/:matchId includes isSeed on each participant', async () => {
    mockTables({
      matches: { data: FAKE_MATCH_ROW, error: null },
      messages: {
        count: 1,
        data: [{ id: 'msg1', sender_id: 'real1', body: 'hi', created_at: '2026-08-05T00:01:00Z', read_at: null }],
        error: null,
      },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/chats/m1', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.match.users).toEqual([
      { id: 'seed1', name: 'Fake Sara', photo: null, isSeed: true },
      { id: 'real1', name: 'Ali', photo: null, isSeed: false },
    ])
  })

  describe('POST /admin/chats/:matchId/messages', () => {
    it('sends as the seed participant', async () => {
      mockTables({
        matches: { data: FAKE_MATCH_ROW, error: null },
        messages: {
          data: { id: 'msg9', sender_id: 'seed1', body: 'hello there', created_at: '2026-08-05T00:02:00Z' },
          error: null,
        },
      })

      const res = await app.inject({
        method: 'POST', url: '/admin/chats/m1/messages', headers, payload: { body: 'hello there' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.message.senderId).toBe('seed1')
      expect(body.message.body).toBe('hello there')
    })

    it('returns 400 no_fake_participant when neither participant is a seed', async () => {
      mockTables({ matches: { data: MATCH_ROW, error: null } })

      const res = await app.inject({
        method: 'POST', url: '/admin/chats/m1/messages', headers, payload: { body: 'hi' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'no_fake_participant' })
    })

    it('returns 400 empty_message for an empty/whitespace body', async () => {
      const res = await app.inject({
        method: 'POST', url: '/admin/chats/m1/messages', headers, payload: { body: '   ' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'empty_message' })
    })

    it('returns 400 message_too_long for a body over 2000 characters', async () => {
      const res = await app.inject({
        method: 'POST', url: '/admin/chats/m1/messages', headers, payload: { body: 'x'.repeat(2001) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'message_too_long' })
    })

    it('returns 404 match_not_found for an unknown match', async () => {
      mockTables({ matches: { data: null, error: { code: 'PGRST116', message: 'not found' } } })

      const res = await app.inject({
        method: 'POST', url: '/admin/chats/nope/messages', headers, payload: { body: 'hi' },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    })
  })

  describe('GET /admin/chats/unread-count', () => {
    it('returns count 1 when a fake chat has an unread message from the real user', async () => {
      mockTables({
        users: { data: [{ id: 'seed1' }], error: null },
        matches: { data: [{ id: 'm1', user1_id: 'seed1', user2_id: 'real1' }], error: null },
        messages: { data: [{ match_id: 'm1', sender_id: 'real1' }], error: null },
      })

      const res = await app.inject({ method: 'GET', url: '/admin/chats/unread-count', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ count: 1 })
    })

    it('returns count 0 when there are no seed users', async () => {
      mockTables({ users: { data: [], error: null } })

      const res = await app.inject({ method: 'GET', url: '/admin/chats/unread-count', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ count: 0 })
    })

    it('returns count 0 when the only unread message in a fake chat was sent by the seed, not the real user', async () => {
      mockTables({
        users: { data: [{ id: 'seed1' }], error: null },
        matches: { data: [{ id: 'm1', user1_id: 'seed1', user2_id: 'real1' }], error: null },
        messages: { data: [{ match_id: 'm1', sender_id: 'seed1', read_at: null }], error: null },
      })

      const res = await app.inject({ method: 'GET', url: '/admin/chats/unread-count', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ count: 0 })
    })
  })

  it('GET /admin/chats?filter=fake-unread returns only fake-unread matches', async () => {
    mockTables({
      users: { data: [{ id: 'seed1' }], error: null },
      matches: { data: [FAKE_MATCH_ROW], error: null },
      messages: {
        data: [{ match_id: 'm1', sender_id: 'real1', body: 'hi there', created_at: '2026-08-06T00:00:00Z' }],
        count: 1,
        error: null,
      },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/chats?filter=fake-unread', headers })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].matchId).toBe('m1')
    expect(body.items[0].lastMessage).toEqual({ body: 'hi there', createdAt: '2026-08-06T00:00:00Z' })
  })
})
