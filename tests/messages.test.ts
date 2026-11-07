import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { notifyNewMessage } from '../src/bot.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow, sql } from './helpers/db.js'

const OTHER_TELEGRAM_ID = 999
const MISSING_UUID = '00000000-0000-0000-0000-000000000000'
const RECENT = () => new Date().toISOString()
const STALE = () => new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20 minutes ago

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let other: Record<string, any>
let match: Record<string, any>

/** Ali (sender, exempt from the free-chat gate: a woman seeking men) matched with Sara. */
async function setup(otherOverrides: Record<string, unknown> = {}) {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men', locale: 'fa', last_active: RECENT() })
  other = await createUser({
    name: 'Sara', telegram_id: OTHER_TELEGRAM_ID, locale: 'en', last_active: RECENT(), ...otherOverrides,
  })
  match = await createMatch(me.id, other.id)
  authAs(me)
}

const url = (matchId = match.id) => `/matches/${matchId}/messages`

function message(row: Record<string, unknown>) {
  return insertRow('messages', { match_id: match.id, sender_id: me.id, body: 'hi', ...row })
}

/** Let the fire-and-forget notification chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 100))

describe('GET /matches/:matchId/messages', () => {
  beforeEach(() => setup())

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: url() })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when the requester is not a participant in the match', async () => {
    const a = await createUser()
    const theirs = await createMatch(a.id, other.id)
    const res = await app.inject({ method: 'GET', url: url(theirs.id), headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when the match does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: url(MISSING_UUID), headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 (not 500) for a malformed match id', async () => {
    const res = await app.inject({ method: 'GET', url: url('not-a-uuid'), headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when the other participant has deleted their account', async () => {
    await sql`update users set deleted_at = '2026-07-30T00:00:00Z' where id = ${other.id}`
    const res = await app.inject({ method: 'GET', url: url(), headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 when one of the two users has blocked the other', async () => {
    await insertRow('blocks', { blocker_id: other.id, blocked_id: me.id })
    const res = await app.inject({ method: 'GET', url: url(), headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns the thread ordered oldest-first and marks the other side read', async () => {
    const txn = await insertRow('gift_transactions', {
      buyer_id: other.id, recipient_id: me.id, context: 'chat', match_id: match.id,
      gift_id: 'rose', gift_emoji: '🌹', gift_star_cost: 25, charged_stars: 30, status: 'sent',
    })
    // Inserted out of order on purpose — the route orders by created_at.
    const m2 = await message({ sender_id: other.id, body: 'hi', created_at: '2026-01-01T10:01:00Z', read_at: '2026-01-01T10:05:00Z', edited_at: '2026-01-01T10:03:00Z' })
    const m1 = await message({ sender_id: me.id, body: 'hey', created_at: '2026-01-01T10:00:00Z' })
    await sql`update messages set reply_to_message_id = ${m1.id} where id = ${m2.id}`
    const m0 = await message({ sender_id: other.id, body: 'My weirdest skill…', icebreaker_answer: 'Juggling', created_at: '2026-01-01T09:59:00Z', type: 'icebreaker' })
    const m3 = await message({ sender_id: other.id, body: null, created_at: '2026-01-01T10:02:00Z', type: 'gift', gift_transaction_id: txn.id })

    const res = await app.inject({ method: 'GET', url: url(), headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      messages: [
        { id: m0.id, senderId: other.id, body: 'My weirdest skill…', type: 'icebreaker', icebreakerAnswer: 'Juggling', gift: null, createdAt: '2026-01-01T09:59:00.000Z', readAt: null, editedAt: null, replyToMessageId: null },
        { id: m1.id, senderId: me.id, body: 'hey', type: 'text', icebreakerAnswer: null, gift: null, createdAt: '2026-01-01T10:00:00.000Z', readAt: null, editedAt: null, replyToMessageId: null },
        { id: m2.id, senderId: other.id, body: 'hi', type: 'text', icebreakerAnswer: null, gift: null, createdAt: '2026-01-01T10:01:00.000Z', readAt: '2026-01-01T10:05:00.000Z', editedAt: '2026-01-01T10:03:00.000Z', replyToMessageId: m1.id },
        { id: m3.id, senderId: other.id, body: null, type: 'gift', icebreakerAnswer: null, gift: { emoji: '🌹', starCost: 25 }, createdAt: '2026-01-01T10:02:00.000Z', readAt: null, editedAt: null, replyToMessageId: null },
      ],
    })

    // Read receipt: the other side's unread rows are stamped; mine and the
    // already-read one are untouched.
    const rows = await sql`select id, read_at from messages`
    const readAt = Object.fromEntries(rows.map((r) => [r.id, r.read_at]))
    expect(readAt[m0.id]).not.toBeNull()
    expect(readAt[m3.id]).not.toBeNull()
    expect(readAt[m2.id]).toBe('2026-01-01T10:05:00.000Z')
    expect(readAt[m1.id]).toBeNull()
  })

  it('returns gift: { emoji: null } when the transaction has no emoji', async () => {
    const txn = await insertRow('gift_transactions', {
      buyer_id: other.id, recipient_id: me.id, context: 'chat', gift_id: 'g', gift_star_cost: 15, charged_stars: 15,
    })
    await message({ sender_id: other.id, body: null, type: 'gift', gift_transaction_id: txn.id })
    const res = await app.inject({ method: 'GET', url: url(), headers: AUTH })
    expect(res.json().messages[0].gift).toEqual({ emoji: null, starCost: 15 })
  })
})

describe('POST /matches/:matchId/messages', () => {
  const send = (payload: Record<string, unknown>, matchId?: string) =>
    app.inject({ method: 'POST', url: url(matchId), headers: AUTH, payload })

  describe('validation and access', () => {
    beforeEach(() => setup())

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({ method: 'POST', url: url(), payload: { body: 'hi' } })
      expect(res.statusCode).toBe(401)
    })

    it('returns 400 for an empty/whitespace body', async () => {
      const res = await send({ body: '   ' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'empty_message' })
    })

    it('returns 400 for a body over 2000 characters', async () => {
      const res = await send({ body: 'x'.repeat(2001) })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'message_too_long' })
    })

    it('returns 404 when the match is not usable', async () => {
      await sql`update users set deleted_at = '2026-07-30T00:00:00Z' where id = ${other.id}`
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(404)
      expect(await sql`select id from messages`).toHaveLength(0)
    })

    it('returns 404 (not 500) for a malformed match id', async () => {
      const res = await send({ body: 'hi' }, 'nope')
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    })

    it('returns 404 when the pair is blocked', async () => {
      await insertRow('blocks', { blocker_id: me.id, blocked_id: other.id })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    })

    it('inserts and returns the trimmed message on success', async () => {
      const res = await send({ body: '  hi  ' })

      expect(res.statusCode).toBe(200)
      const [row] = await sql`select id, sender_id, body, created_at, type from messages`
      expect(row).toMatchObject({ sender_id: me.id, body: 'hi', type: 'text' })
      expect(res.json()).toEqual({
        message: { id: row.id, senderId: me.id, body: 'hi', createdAt: row.created_at, readAt: null, editedAt: null, replyToMessageId: null },
      })
      // trg_bump_match_last_message_at moved the match's activity stamp.
      const [m] = await sql`select last_message_at from matches where id = ${match.id}`
      expect(m.last_message_at).toBe(row.created_at)
    })

    it('inserts a reply and returns replyToMessageId when the parent is in the same match', async () => {
      const parent = await message({ sender_id: other.id, body: 'q' })
      const res = await send({ body: 'hi', replyToMessageId: parent.id })

      expect(res.statusCode).toBe(200)
      expect(res.json().message).toMatchObject({ senderId: me.id, body: 'hi', replyToMessageId: parent.id })
      const [row] = await sql`select reply_to_message_id from messages where id = ${res.json().message.id}`
      expect(row.reply_to_message_id).toBe(parent.id)
    })

    it('returns 400 when the reply target does not belong to this match', async () => {
      const elsewhere = await createUser()
      const otherMatch = await createMatch(me.id, elsewhere.id)
      const foreign = await insertRow('messages', { match_id: otherMatch.id, sender_id: elsewhere.id, body: 'x' })

      for (const replyToMessageId of [foreign.id, MISSING_UUID, 'parent-x' /* malformed → same 400 */]) {
        const res = await send({ body: 'hi', replyToMessageId })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'invalid_reply_target' })
      }
      expect(await sql`select id from messages where match_id = ${match.id}`).toHaveLength(0)
    })
  })

  describe('offline notification', () => {
    it('sends an offline notification and marks notified_offline_at when the recipient is inactive and not yet notified', async () => {
      await setup({ last_active: STALE(), notified_offline_at: null })
      await createPhoto(me.id, 1, { url: 'https://ali-2.jpg' })
      await createPhoto(me.id, 0, { url: 'https://ali.jpg' })

      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)

      // 5th arg is the matchId so the DM button deep-links straight to this chat;
      // 6th is the RECIPIENT's locale (Sara's 'en', not the sender's 'fa').
      await vi.waitFor(() =>
        expect(notifyNewMessage).toHaveBeenCalledWith(OTHER_TELEGRAM_ID, 'Ali', 'hi', 'https://ali.jpg', match.id, 'en'))
      await vi.waitFor(async () => {
        const [row] = await sql`select notified_offline_at from users where id = ${other.id}`
        expect(row.notified_offline_at).not.toBeNull()
      })
    })

    it('passes a null locale and null photo when the offline recipient has no language and the sender no photo', async () => {
      await setup({ last_active: STALE(), notified_offline_at: null, locale: null })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await vi.waitFor(() =>
        expect(notifyNewMessage).toHaveBeenCalledWith(OTHER_TELEGRAM_ID, 'Ali', 'hi', null, match.id, null))
    })

    it('does not stamp notified_offline_at when the bot send fails', async () => {
      await setup({ last_active: STALE(), notified_offline_at: null })
      vi.mocked(notifyNewMessage).mockRejectedValueOnce(new Error('bot blocked'))
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await settle()
      const [row] = await sql`select notified_offline_at from users where id = ${other.id}`
      expect(row.notified_offline_at).toBeNull()
    })

    it('does not send an offline notification when the recipient is online', async () => {
      await setup({ last_active: RECENT(), notified_offline_at: null })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await settle()
      expect(notifyNewMessage).not.toHaveBeenCalled()
    })

    it('woman: does not notify again when already notified in the last 4h of this offline stretch', async () => {
      const stamp = STALE() // minutes ago — well inside the 4h cooldown
      await setup({ gender: 'woman', last_active: STALE(), notified_offline_at: stamp })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await settle()
      expect(notifyNewMessage).not.toHaveBeenCalled()
      const [row] = await sql`select notified_offline_at from users where id = ${other.id}`
      expect(row.notified_offline_at).toBe(new Date(stamp).toISOString())
    })

    it('woman: notifies again once the previous DM is older than 4h', async () => {
      const stamp = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
      await setup({ gender: 'woman', last_active: STALE(), notified_offline_at: stamp })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await settle()
      expect(notifyNewMessage).toHaveBeenCalledTimes(1)
      const [row] = await sql`select notified_offline_at from users where id = ${other.id}`
      expect(new Date(row.notified_offline_at).getTime()).toBeGreaterThan(new Date(stamp).getTime())
    })

    it('man: is notified for every message while offline, even if just notified', async () => {
      await setup({ gender: 'man', last_active: STALE(), notified_offline_at: STALE() })
      const res = await send({ body: 'hi' })
      expect(res.statusCode).toBe(200)
      await settle()
      expect(notifyNewMessage).toHaveBeenCalledTimes(1)
    })
  })
})

describe('PATCH /matches/:matchId/messages/:messageId', () => {
  beforeEach(() => setup())

  const patch = (messageId: string, payload: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'PATCH', url: `${url()}/${messageId}`, headers, payload })

  it('returns 401 when unauthenticated', async () => {
    const res = await patch(MISSING_UUID, { body: 'hi' }, {})
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 for an empty/whitespace body', async () => {
    const res = await patch(MISSING_UUID, { body: '   ' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_message' })
  })

  it('returns 400 for a body over 2000 characters', async () => {
    const res = await patch(MISSING_UUID, { body: 'x'.repeat(2001) })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'message_too_long' })
  })

  it('returns 404 when the match is not usable', async () => {
    const msg = await message({ body: 'old' })
    await sql`update users set deleted_at = '2026-07-30T00:00:00Z' where id = ${other.id}`
    const res = await patch(msg.id, { body: 'hi' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when no row matches (missing message or not the sender)', async () => {
    const theirs = await message({ sender_id: other.id, body: 'theirs' })
    for (const id of [MISSING_UUID, theirs.id, 'msg-uuid-1' /* malformed */]) {
      const res = await patch(id, { body: 'hi' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'message_not_found' })
    }
    const [row] = await sql`select body, edited_at from messages where id = ${theirs.id}`
    expect(row).toEqual({ body: 'theirs', edited_at: null })
  })

  it('returns 404 for a message in another match even when I sent it', async () => {
    const x = await createUser()
    const otherMatch = await createMatch(me.id, x.id)
    const mine = await insertRow('messages', { match_id: otherMatch.id, sender_id: me.id, body: 'elsewhere' })
    const res = await patch(mine.id, { body: 'hi' })
    expect(res.statusCode).toBe(404)
  })

  it('updates the body, stamps edited_at, and leaves read_at alone', async () => {
    const parent = await message({ sender_id: other.id, body: 'q' })
    const msg = await message({
      body: 'typo', created_at: '2026-01-01T10:00:00Z', read_at: '2026-01-01T10:05:00Z', reply_to_message_id: parent.id,
    })

    const res = await patch(msg.id, { body: '  fixed  ' })

    expect(res.statusCode).toBe(200)
    const [row] = await sql`select body, read_at, edited_at from messages where id = ${msg.id}`
    expect(row.body).toBe('fixed')
    expect(row.read_at).toBe('2026-01-01T10:05:00.000Z')
    expect(row.edited_at).not.toBeNull()
    expect(res.json()).toEqual({
      message: {
        id: msg.id, senderId: me.id, body: 'fixed', createdAt: '2026-01-01T10:00:00.000Z',
        readAt: '2026-01-01T10:05:00.000Z', editedAt: row.edited_at, replyToMessageId: parent.id,
      },
    })
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('returns 404 for an icebreaker (or gift) message — only text is editable', async () => {
    const ice = await message({ body: 'Q?', type: 'icebreaker' })
    const res = await patch(ice.id, { body: 'hi' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'message_not_found' })
    const [row] = await sql`select body from messages where id = ${ice.id}`
    expect(row.body).toBe('Q?')
  })
})

describe('DELETE /matches/:matchId/messages/:messageId', () => {
  beforeEach(() => setup())

  const del = (messageId: string, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'DELETE', url: `${url()}/${messageId}`, headers })

  it('returns 401 when unauthenticated', async () => {
    const res = await del(MISSING_UUID, {})
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 when the match is not usable', async () => {
    const msg = await message({})
    await sql`update users set deleted_at = '2026-07-30T00:00:00Z' where id = ${other.id}`
    const res = await del(msg.id)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 when nothing was deleted (missing message or not the sender)', async () => {
    const theirs = await message({ sender_id: other.id })
    for (const id of [MISSING_UUID, theirs.id, 'msg-uuid-1' /* malformed */]) {
      const res = await del(id)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'message_not_found' })
    }
    expect(await sql`select id from messages`).toHaveLength(1)
  })

  it('hard-deletes the row scoped to id+match+sender and returns ok', async () => {
    const mine = await message({})
    const keep = await message({ body: 'keep' })

    const res = await del(mine.id)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await sql`select id from messages`).map((r) => r.id)).toEqual([keep.id])
  })
})
