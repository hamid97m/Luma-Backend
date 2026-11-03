import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn() }))

import { buildApp } from '../src/server.js'
import { chatHub } from '../src/realtime/hub.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow, sql } from './helpers/db.js'

// The viewer is a woman seeking men → exempt from the free-chat gate, so every
// match stays premiumRequired: false (gate behaviour lives in matches-premium).
async function viewer() {
  return createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
}

/** Insert a message; the trigger bumps matches.last_message_at for real. */
function message(match_id: string, sender_id: string, row: Record<string, unknown> = {}) {
  return insertRow('messages', { match_id, sender_id, body: 'hi', ...row })
}

describe('GET /matches', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let sara: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await viewer()
    sara = await createUser({
      name: 'Sara', gender: 'woman', looking_for: 'men', age: 24, bio: 'Coffee person',
      icebreaker_prompt: 'My perfect Sunday', icebreaker_answer: 'Hiking then pancakes',
    })
    authAs(me)
  })

  const get = () => app.inject({ method: 'GET', url: '/matches', headers: AUTH })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches' })
    expect(res.statusCode).toBe(401)
  })

  it('returns list of matches with other user info, last message, and unread count', async () => {
    const m = await createMatch(me.id, sara.id, { created_at: '2026-01-01T00:00:00Z' })
    await createPhoto(sara.id, 1, { url: 'https://img/1' })
    await createPhoto(sara.id, 0, { url: 'https://img/0' })
    await message(m.id, sara.id, { body: 'first', created_at: '2026-01-01T12:00:00Z' })
    await message(m.id, me.id, { body: 'mine', created_at: '2026-01-01T13:00:00Z', read_at: null })
    const last = await message(m.id, sara.id, { body: 'hey there', created_at: '2026-01-02T00:00:00Z' })
    await message(m.id, sara.id, { body: 'already read', created_at: '2026-01-01T11:00:00Z', read_at: '2026-01-01T11:30:00Z' })

    const res = await get()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.matches).toHaveLength(1)
    const [row] = body.matches
    expect(row.id).toBe(m.id)
    expect(row.matchedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(row.user).toEqual({
      id: sara.id, name: 'Sara', age: 24, bio: 'Coffee person',
      icebreakerPrompt: 'My perfect Sunday', icebreakerAnswer: 'Hiking then pancakes',
      photos: ['https://img/0', 'https://img/1'], premium: false, online: false,
    })
    expect(row.lastMessage).toEqual({
      id: last.id, body: 'hey there', createdAt: '2026-01-02T00:00:00.000Z', senderId: sara.id, type: 'text', readAt: null,
    })
    // Two unread from Sara; her read one and my own don't count.
    expect(row.unreadCount).toBe(2)
    expect(row.premiumRequired).toBe(false)
  })

  it("returns the last message's type so an auto-posted icebreaker can be labelled", async () => {
    const m = await createMatch(me.id, sara.id)
    await message(m.id, sara.id, { body: 'My weirdest skill…', type: 'icebreaker' })
    const res = await get()
    expect(res.json().matches[0].lastMessage.type).toBe('icebreaker')
  })

  it("reports lastMessage.type 'text' for a plain message (the column default)", async () => {
    const m = await createMatch(me.id, sara.id)
    await message(m.id, sara.id, { body: 'hey' })
    const res = await get()
    expect(res.json().matches[0].lastMessage.type).toBe('text')
  })

  it('marks the other user premium only while premium_until is still in the future', async () => {
    const future = await createUser({ name: 'P', premium_until: '2099-01-01T00:00:00.000Z' })
    const past = await createUser({ name: 'X', premium_until: '2020-01-01T00:00:00.000Z' })
    await createMatch(me.id, future.id, { created_at: '2026-01-02T00:00:00Z' })
    await createMatch(past.id, me.id, { created_at: '2026-01-01T00:00:00Z' })

    const res = await get()
    const byName = Object.fromEntries(res.json().matches.map((m: any) => [m.user.name, m.user.premium]))
    expect(byName).toEqual({ P: true, X: false })
  })

  it('flags the other user online while they have an open stream in the hub', async () => {
    const away = await createUser({ name: 'Away' })
    await createMatch(me.id, sara.id, { created_at: '2026-01-02T00:00:00Z' })
    await createMatch(me.id, away.id, { created_at: '2026-01-01T00:00:00Z' })
    const off = chatHub.addStream(sara.id, { write: () => {}, close: () => {} })
    try {
      const res = await get()
      const byName = Object.fromEntries(res.json().matches.map((m: any) => [m.user.name, m.user.online]))
      expect(byName).toEqual({ Sara: true, Away: false })
    } finally {
      off()
    }
  })

  it('returns null lastMessage, 0 unreadCount and no photos when there are no messages yet', async () => {
    await createMatch(sara.id, me.id) // viewer as user2 works too
    const res = await get()
    const [row] = res.json().matches
    expect(row.user.id).toBe(sara.id)
    expect(row.lastMessage).toBeNull()
    expect(row.unreadCount).toBe(0)
    expect(row.user.photos).toEqual([])
  })

  it('orders chats by last-message time, newest first, falling back to match time', async () => {
    const nika = await createUser({ name: 'Nika' })
    // match-old was created first but has the most recent message; match-new
    // is a newer match with no messages yet. Activity order beats match order.
    const matchNew = await createMatch(me.id, sara.id, { created_at: '2026-01-05T00:00:00Z' })
    const matchOld = await createMatch(me.id, nika.id, {
      created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-01T00:00:00Z',
    })
    await message(matchOld.id, nika.id, { body: 'salam', created_at: '2026-01-10T00:00:00Z' })

    const res = await get()

    expect(res.statusCode).toBe(200)
    expect(res.json().matches.map((m: any) => m.id)).toEqual([matchOld.id, matchNew.id])
    // The messages trigger keeps last_message_at in step for real now (it only moves forward).
    const [row] = await sql`select last_message_at from matches where id = ${matchOld.id}`
    expect(row.last_message_at).toBe('2026-01-10T00:00:00.000Z')
  })

  it('excludes a match whose counterpart has deleted their account', async () => {
    const gone = await createUser({ name: '', deleted_at: '2026-07-30T00:00:00Z' })
    await createMatch(me.id, gone.id)

    const res = await get()

    expect(res.statusCode).toBe(200)
    expect(res.json().matches).toHaveLength(0)
  })

  it('does not list other people\'s matches', async () => {
    const a = await createUser()
    await createMatch(a.id, sara.id)
    expect((await get()).json().matches).toEqual([])
  })
})

describe('GET /matches/unread-count', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let other: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await viewer()
    other = await createUser({ name: 'Sara' })
  })

  const get = () => app.inject({ method: 'GET', url: '/matches/unread-count', headers: AUTH })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/unread-count' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the aggregate unread count across active matches', async () => {
    const third = await createUser()
    const m1 = await createMatch(me.id, other.id)
    const m2 = await createMatch(third.id, me.id)
    await message(m1.id, other.id)
    await message(m1.id, other.id)
    await message(m2.id, third.id)
    await message(m2.id, third.id, { read_at: new Date().toISOString() }) // read
    await message(m1.id, me.id) // my own

    authAs(me)
    const res = await get()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 3 })
  })

  it('excludes deleted-counterpart matches from the count', async () => {
    const gone = await createUser({ deleted_at: '2026-07-30T00:00:00Z' })
    const m1 = await createMatch(me.id, other.id)
    const m2 = await createMatch(me.id, gone.id)
    await message(m1.id, other.id)
    await message(m2.id, gone.id)
    await message(m2.id, gone.id)

    authAs(me)
    expect((await get()).json()).toEqual({ count: 1 })
  })

  it('excludes matches whose counterpart is blocked (either direction) from the count', async () => {
    const blockedByMe = await createUser()
    const blockedMe = await createUser()
    const m1 = await createMatch(me.id, other.id)
    const m2 = await createMatch(me.id, blockedByMe.id)
    const m3 = await createMatch(blockedMe.id, me.id)
    await insertRow('blocks', { blocker_id: me.id, blocked_id: blockedByMe.id })
    await insertRow('blocks', { blocker_id: blockedMe.id, blocked_id: me.id })
    for (let i = 0; i < 5; i++) await message(m1.id, other.id)
    await message(m2.id, blockedByMe.id)
    await message(m3.id, blockedMe.id)

    authAs(me)
    expect((await get()).json()).toEqual({ count: 5 })
  })

  it('returns 0 when there are no active matches', async () => {
    authAs(me)
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0 })
  })
})
