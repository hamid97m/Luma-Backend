import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'
const OTHER_ID = 'user-uuid-2'
const MATCH_ID = 'match-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

function mockMatchLookup(overrides: Partial<{ user1_id: string; user2_id: string; otherDeletedAt: string | null }> = {}) {
  const { user1_id = USER_ID, user2_id = OTHER_ID, otherDeletedAt = null } = overrides
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      eq: () => ({
        single: () => ({
          data: {
            id: MATCH_ID,
            user1_id,
            user2_id,
            user1: { id: user1_id, deleted_at: user1_id === USER_ID ? null : otherDeletedAt },
            user2: { id: user2_id, deleted_at: user2_id === OTHER_ID ? otherDeletedAt : null },
          },
        }),
      }),
    }),
  } as any)
}

describe('GET /matches/:matchId/messages', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: `/matches/${MATCH_ID}/messages` })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when the requester is not a participant in the match', async () => {
    setupAuth()
    mockMatchLookup({ user1_id: 'someone-else', user2_id: OTHER_ID })

    const res = await app.inject({ method: 'GET', url: `/matches/${MATCH_ID}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when the other participant has deleted their account', async () => {
    setupAuth()
    mockMatchLookup({ otherDeletedAt: '2026-07-30T00:00:00Z' })

    const res = await app.inject({ method: 'GET', url: `/matches/${MATCH_ID}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('returns the thread ordered oldest-first and marks the other side read', async () => {
    setupAuth()
    mockMatchLookup()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () => ({
            data: [
              { id: 'm1', sender_id: USER_ID, body: 'hey', created_at: '2026-01-01T10:00:00Z' },
              { id: 'm2', sender_id: OTHER_ID, body: 'hi', created_at: '2026-01-01T10:01:00Z' },
            ],
            error: null,
          }),
        }),
      }),
    } as any)

    const updateEq = vi.fn(() => ({ neq: () => ({ is: () => ({ error: null }) }) }))
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: updateEq }),
    } as any)

    const res = await app.inject({ method: 'GET', url: `/matches/${MATCH_ID}/messages`, headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      messages: [
        { id: 'm1', senderId: USER_ID, body: 'hey', createdAt: '2026-01-01T10:00:00Z' },
        { id: 'm2', senderId: OTHER_ID, body: 'hi', createdAt: '2026-01-01T10:01:00Z' },
      ],
    })
    expect(updateEq).toHaveBeenCalledWith('match_id', MATCH_ID)
  })
})

describe('POST /matches/:matchId/messages', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: `/matches/${MATCH_ID}/messages`, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 for an empty/whitespace body', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_message' })
  })

  it('returns 400 for a body over 2000 characters', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'message_too_long' })
  })

  it('returns 404 when the match is not usable', async () => {
    setupAuth()
    mockMatchLookup({ otherDeletedAt: '2026-07-30T00:00:00Z' })

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('inserts and returns the trimmed message on success', async () => {
    setupAuth()
    mockMatchLookup()

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm3', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z' },
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: '  hi  ' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      message: { id: 'm3', senderId: USER_ID, body: 'hi', createdAt: '2026-01-01T10:02:00Z' },
    })
  })
})
