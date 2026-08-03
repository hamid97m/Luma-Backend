import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { notifyNewMessage } from '../src/bot.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'
const OTHER_ID = 'user-uuid-2'
const OTHER_TELEGRAM_ID = 999
const MATCH_ID = 'match-uuid-1'
const RECENT = new Date().toISOString()
const STALE = new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20 minutes ago

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

function mockMatchLookup(overrides: Partial<{
  user1_id: string
  user2_id: string
  otherDeletedAt: string | null
  otherLastActive: string | null
  otherNotifiedOfflineAt: string | null
}> = {}) {
  const {
    user1_id = USER_ID,
    user2_id = OTHER_ID,
    otherDeletedAt = null,
    otherLastActive = RECENT,
    otherNotifiedOfflineAt = null,
  } = overrides
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      eq: () => ({
        single: () => ({
          data: {
            id: MATCH_ID,
            user1_id,
            user2_id,
            user1: {
              id: user1_id, name: 'Ali', telegram_id: 1,
              deleted_at: user1_id === USER_ID ? null : otherDeletedAt,
              last_active: user1_id === USER_ID ? RECENT : otherLastActive,
              notified_offline_at: user1_id === USER_ID ? null : otherNotifiedOfflineAt,
            },
            user2: {
              id: user2_id, name: 'Sara', telegram_id: OTHER_TELEGRAM_ID,
              deleted_at: user2_id === OTHER_ID ? otherDeletedAt : null,
              last_active: user2_id === OTHER_ID ? otherLastActive : RECENT,
              notified_offline_at: user2_id === OTHER_ID ? otherNotifiedOfflineAt : null,
            },
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
              { id: 'm1', sender_id: USER_ID, body: 'hey', created_at: '2026-01-01T10:00:00Z', read_at: null, edited_at: null },
              { id: 'm2', sender_id: OTHER_ID, body: 'hi', created_at: '2026-01-01T10:01:00Z', read_at: '2026-01-01T10:05:00Z', edited_at: '2026-01-01T10:03:00Z' },
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
        { id: 'm1', senderId: USER_ID, body: 'hey', createdAt: '2026-01-01T10:00:00Z', readAt: null, editedAt: null },
        { id: 'm2', senderId: OTHER_ID, body: 'hi', createdAt: '2026-01-01T10:01:00Z', readAt: '2026-01-01T10:05:00Z', editedAt: '2026-01-01T10:03:00Z' },
      ],
    })
    expect(updateEq).toHaveBeenCalledWith('match_id', MATCH_ID)
  })
})

describe('POST /matches/:matchId/messages', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

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
      message: { id: 'm3', senderId: USER_ID, body: 'hi', createdAt: '2026-01-01T10:02:00Z', readAt: null, editedAt: null },
    })
  })

  it('sends an offline notification and marks notified_offline_at when the recipient is inactive and not yet notified', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: STALE, otherNotifiedOfflineAt: null })

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm4', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z' },
            error: null,
          }),
        }),
      }),
    } as any)

    const markUpdateEq = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.from).mockReturnValueOnce({ update: () => ({ eq: markUpdateEq }) } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)

    // Flush the fire-and-forget notify chain before asserting on it.
    await new Promise((resolve) => setImmediate(resolve))

    expect(notifyNewMessage).toHaveBeenCalledWith(OTHER_TELEGRAM_ID, 'Ali', 'hi')
    expect(markUpdateEq).toHaveBeenCalledWith('id', OTHER_ID)
  })

  it('does not send an offline notification when the recipient is online', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: RECENT, otherNotifiedOfflineAt: null })

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm5', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z' },
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('does not notify again when the recipient was already notified during this offline stretch', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: STALE, otherNotifiedOfflineAt: STALE })

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm6', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z' },
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })
})
