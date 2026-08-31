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

// POST reads the sender's cohort for the free-chat gate. A woman short-circuits
// as exempt (no premium_config / messages reads), so sending is always allowed.
function mockChatGateExempt() {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { gender: 'woman', looking_for: 'women', premium_until: null }, error: null }) }) }),
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
              { id: 'm1', sender_id: USER_ID, body: 'hey', created_at: '2026-01-01T10:00:00Z', read_at: null, edited_at: null, reply_to_message_id: null, type: 'text', gift_transaction_id: null, gift: null },
              { id: 'm2', sender_id: OTHER_ID, body: 'hi', created_at: '2026-01-01T10:01:00Z', read_at: '2026-01-01T10:05:00Z', edited_at: '2026-01-01T10:03:00Z', reply_to_message_id: 'm1', type: 'text', gift_transaction_id: null, gift: null },
              { id: 'm3', sender_id: OTHER_ID, body: null, created_at: '2026-01-01T10:02:00Z', read_at: null, edited_at: null, reply_to_message_id: null, type: 'gift', gift_transaction_id: 'txn-1', gift: { gift_emoji: '🌹', gift_star_cost: 25 } },
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
        { id: 'm1', senderId: USER_ID, body: 'hey', type: 'text', gift: null, createdAt: '2026-01-01T10:00:00Z', readAt: null, editedAt: null, replyToMessageId: null },
        { id: 'm2', senderId: OTHER_ID, body: 'hi', type: 'text', gift: null, createdAt: '2026-01-01T10:01:00Z', readAt: '2026-01-01T10:05:00Z', editedAt: '2026-01-01T10:03:00Z', replyToMessageId: 'm1' },
        { id: 'm3', senderId: OTHER_ID, body: null, type: 'gift', gift: { emoji: '🌹', starCost: 25 }, createdAt: '2026-01-01T10:02:00Z', readAt: null, editedAt: null, replyToMessageId: null },
      ],
    })
    const giftMessage = res.json().messages.find((m: any) => m.id === 'm3')
    expect(giftMessage.type).toBe('gift')
    expect(giftMessage.gift.emoji).toBe('🌹')
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
    mockChatGateExempt()

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm3', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z', reply_to_message_id: null },
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
      message: { id: 'm3', senderId: USER_ID, body: 'hi', createdAt: '2026-01-01T10:02:00Z', readAt: null, editedAt: null, replyToMessageId: null },
    })
  })

  it('sends an offline notification and marks notified_offline_at when the recipient is inactive and not yet notified', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: STALE, otherNotifiedOfflineAt: null })
    mockChatGateExempt()

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm4', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z', reply_to_message_id: null },
            error: null,
          }),
        }),
      }),
    } as any)

    // Sender's primary photo lookup — feeds the 4th arg of notifyNewMessage.
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => ({ data: { url: 'https://ali.jpg' } }) }) }) }) }),
    } as any)

    const markUpdateEq = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.from).mockReturnValueOnce({ update: () => ({ eq: markUpdateEq }) } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)

    // Flush the fire-and-forget notify chain before asserting on it.
    await new Promise((resolve) => setImmediate(resolve))

    expect(notifyNewMessage).toHaveBeenCalledWith(OTHER_TELEGRAM_ID, 'Ali', 'hi', 'https://ali.jpg')
    expect(markUpdateEq).toHaveBeenCalledWith('id', OTHER_ID)
  })

  it('does not send an offline notification when the recipient is online', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: RECENT, otherNotifiedOfflineAt: null })
    mockChatGateExempt()

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm5', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z', reply_to_message_id: null },
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

  it('inserts a reply and returns replyToMessageId when the parent is in the same match', async () => {
    setupAuth()
    mockMatchLookup()
    mockChatGateExempt()

    // parent-message validation lookup: .select('id').eq().eq().maybeSingle()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => ({ data: { id: 'parent-1' }, error: null }) }) }) }),
    } as any)

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm7', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z', reply_to_message_id: 'parent-1' },
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi', replyToMessageId: 'parent-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      message: { id: 'm7', senderId: USER_ID, body: 'hi', createdAt: '2026-01-01T10:02:00Z', readAt: null, editedAt: null, replyToMessageId: 'parent-1' },
    })
  })

  it('returns 400 when the reply target does not belong to this match', async () => {
    setupAuth()
    mockMatchLookup()
    mockChatGateExempt()

    // parent lookup finds nothing (wrong match or nonexistent)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => ({ data: null, error: null }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: `/matches/${MATCH_ID}/messages`, headers: AUTH, payload: { body: 'hi', replyToMessageId: 'parent-x' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_reply_target' })
  })

  it('does not notify again when the recipient was already notified during this offline stretch', async () => {
    setupAuth()
    mockMatchLookup({ otherLastActive: STALE, otherNotifiedOfflineAt: STALE })
    mockChatGateExempt()

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({
        select: () => ({
          single: () => ({
            data: { id: 'm6', sender_id: USER_ID, body: 'hi', created_at: '2026-01-01T10:02:00Z', reply_to_message_id: null },
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

describe('PATCH /matches/:matchId/messages/:messageId', () => {
  const MSG_ID = 'msg-uuid-1'
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  function mockUpdateChain(result: { data: any; error: any }) {
    const eqCalls: Array<[string, string]> = []
    const chain: any = {
      eq: (col: string, val: string) => { eqCalls.push([col, val]); return chain },
      select: () => ({ maybeSingle: () => result }),
    }
    const update = vi.fn(() => chain)
    vi.mocked(db.from).mockReturnValueOnce({ update } as any)
    return { eqCalls, update }
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 for an empty/whitespace body', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH, payload: { body: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_message' })
  })

  it('returns 400 for a body over 2000 characters', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH, payload: { body: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'message_too_long' })
  })

  it('returns 404 when the match is not usable', async () => {
    setupAuth()
    mockMatchLookup({ otherDeletedAt: '2026-07-30T00:00:00Z' })
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when no row matches (missing message or not the sender)', async () => {
    setupAuth()
    mockMatchLookup()
    mockUpdateChain({ data: null, error: null })
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'message_not_found' })
  })

  it('updates the body, stamps edited_at, and scopes the update to id+match+sender', async () => {
    setupAuth()
    mockMatchLookup()
    const { eqCalls, update } = mockUpdateChain({
      data: {
        id: MSG_ID, sender_id: USER_ID, body: 'fixed', created_at: '2026-01-01T10:00:00Z',
        read_at: '2026-01-01T10:05:00Z', edited_at: '2026-01-02T09:00:00Z', reply_to_message_id: 'parent-9',
      },
      error: null,
    })

    const res = await app.inject({
      method: 'PATCH', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH, payload: { body: '  fixed  ' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      message: {
        id: MSG_ID, senderId: USER_ID, body: 'fixed', createdAt: '2026-01-01T10:00:00Z',
        readAt: '2026-01-01T10:05:00Z', editedAt: '2026-01-02T09:00:00Z', replyToMessageId: 'parent-9',
      },
    })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ body: 'fixed', edited_at: expect.any(String) }))
    // read_at must never be part of the update payload
    expect(update.mock.calls[0][0]).not.toHaveProperty('read_at')
    expect(eqCalls).toEqual([['id', MSG_ID], ['match_id', MATCH_ID], ['sender_id', USER_ID]])
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })
})

describe('DELETE /matches/:matchId/messages/:messageId', () => {
  const MSG_ID = 'msg-uuid-1'
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  function mockDeleteChain(result: { data: any; error: any }) {
    const eqCalls: Array<[string, string]> = []
    const chain: any = {
      eq: (col: string, val: string) => { eqCalls.push([col, val]); return chain },
      select: () => result,
    }
    vi.mocked(db.from).mockReturnValueOnce({ delete: () => chain } as any)
    return { eqCalls }
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/matches/${MATCH_ID}/messages/${MSG_ID}` })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when the match is not usable', async () => {
    setupAuth()
    mockMatchLookup({ otherDeletedAt: '2026-07-30T00:00:00Z' })
    const res = await app.inject({ method: 'DELETE', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when nothing was deleted (missing message or not the sender)', async () => {
    setupAuth()
    mockMatchLookup()
    mockDeleteChain({ data: [], error: null })
    const res = await app.inject({ method: 'DELETE', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'message_not_found' })
  })

  it('hard-deletes the row scoped to id+match+sender and returns ok', async () => {
    setupAuth()
    mockMatchLookup()
    const { eqCalls } = mockDeleteChain({ data: [{ id: MSG_ID }], error: null })

    const res = await app.inject({ method: 'DELETE', url: `/matches/${MATCH_ID}/messages/${MSG_ID}`, headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(eqCalls).toEqual([['id', MSG_ID], ['match_id', MATCH_ID], ['sender_id', USER_ID]])
  })
})
