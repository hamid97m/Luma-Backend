import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))
// Cross-area (messaging): asserted as a call, its own tests cover delivery.
vi.mock('../src/messaging/deliver.js', () => ({ deliverMessageNotification: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { deliverMessageNotification } from '../src/messaging/deliver.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

const NO_MATCH = '00000000-0000-0000-0000-000000000000'

describe('admin chats', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let sara: Record<string, any>
  let ali: Record<string, any>
  let seed: Record<string, any>
  let real: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
    sara = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
    ali = await createUser({ name: 'Ali' })
    seed = await createUser({ name: 'Fake Sara', is_seed: true, telegram_id: -1, gender: 'woman', looking_for: 'men' })
    real = await createUser({ name: 'Reza', telegram_id: 999, last_active: new Date().toISOString() })
  })

  const get = (url: string) => app.inject({ method: 'GET', url, headers })
  const msg = (match_id: string, sender_id: string, body: string, extra: Record<string, unknown> = {}) =>
    insertRow('messages', { match_id, sender_id, body, ...extra })

  it('GET /admin/chats lists matches with participants, non-icebreaker count and last message', async () => {
    await createPhoto(sara.id, 1, { url: 'https://s2.jpg' })
    await createPhoto(sara.id, 0, { url: 'https://s.jpg' })
    const m = await createMatch(sara.id, ali.id, { created_at: '2026-08-02T00:00:00Z' })
    await msg(m.id, sara.id, 'Best trip?', { type: 'icebreaker', created_at: '2026-08-04T00:00:00Z' })
    for (let i = 0; i < 3; i++) await msg(m.id, ali.id, `m${i}`, { created_at: `2026-08-02T0${i}:30:00Z` })
    await msg(m.id, sara.id, 'hey', { created_at: '2026-08-03T00:00:00Z' })

    const res = await get('/admin/chats')

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0]).toEqual({
      matchId: m.id,
      matchedAt: '2026-08-02T00:00:00.000Z',
      users: [
        { id: sara.id, name: 'Sara', photo: 'https://s.jpg', isSeed: false },
        { id: ali.id, name: 'Ali', photo: null, isSeed: false },
      ],
      messageCount: 4,
      lastMessage: { body: 'hey', createdAt: '2026-08-03T00:00:00.000Z' },
    })
  })

  it('GET /admin/chats: lastMessage is null for a chat without messages', async () => {
    await createMatch(sara.id, ali.id)
    const body = (await get('/admin/chats')).json()
    expect(body.items[0]).toMatchObject({ messageCount: 0, lastMessage: null })
  })

  it('GET /admin/chats orders the list by last message time (most recent first) and paginates', async () => {
    const base = Date.parse('2026-08-01T00:00:00Z')
    const ids: string[] = []
    for (let i = 0; i < 21; i++) {
      const u = await createUser({ name: `U${i}` })
      const m = await createMatch(sara.id, u.id, { last_message_at: new Date(base + i * 60_000).toISOString() })
      ids.push(m.id)
    }

    const p1 = (await get('/admin/chats')).json()
    expect(p1.total).toBe(21)
    expect(p1.pageCount).toBe(2)
    expect(p1.items.map((i: any) => i.matchId)).toEqual(ids.slice(1).reverse())
    const p2 = (await get('/admin/chats?page=2')).json()
    expect(p2.items.map((i: any) => i.matchId)).toEqual([ids[0]])
  })

  it('GET /admin/chats/:matchId returns participants and paginated transcript (incl. icebreakers)', async () => {
    const m = await createMatch(sara.id, ali.id)
    const ib = await msg(m.id, sara.id, 'Best trip?', {
      type: 'icebreaker', icebreaker_answer: 'Shiraz', created_at: '2026-08-02T00:00:00Z',
    })
    const hi = await msg(m.id, ali.id, 'hi', { created_at: '2026-08-03T00:00:00Z' })

    const res = await get(`/admin/chats/${m.id}`)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.match.id).toBe(m.id)
    expect(body.match.users).toHaveLength(2)
    expect(body.messages.items).toEqual([
      { id: ib.id, senderId: sara.id, body: 'Best trip?', createdAt: '2026-08-02T00:00:00.000Z', readAt: null, type: 'icebreaker', icebreakerAnswer: 'Shiraz' },
      { id: hi.id, senderId: ali.id, body: 'hi', createdAt: '2026-08-03T00:00:00.000Z', readAt: null, type: 'text', icebreakerAnswer: null },
    ])
    expect(body.messages.total).toBe(2)
    expect(body.messages.pageCount).toBe(1)
    // real↔real chat: opening it never forges read receipts
    expect((await sql`select count(*)::int as n from messages where read_at is not null`)[0].n).toBe(0)
  })

  it('returns 404 for an unknown match', async () => {
    const res = await get(`/admin/chats/${NO_MATCH}`)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'match_not_found' })
  })

  it('returns 404 (not 500) for a malformed match id', async () => {
    const res = await get('/admin/chats/nope')
    expect(res.statusCode).toBe(404)
  })

  it('returns 500 when the chats query fails', async () => {
    await createMatch(sara.id, ali.id)
    const res = await withTableBroken('messages', () => get('/admin/chats'))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'chats_fetch_failed' })
  })

  it('returns 500 (not 404) when the match lookup fails with a real DB error', async () => {
    const m = await createMatch(sara.id, ali.id)
    const res = await withTableBroken('user_photos', () => get(`/admin/chats/${m.id}`))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'chats_fetch_failed' })
  })

  it('returns 500 when the transcript messages query fails', async () => {
    const m = await createMatch(sara.id, ali.id)
    const res = await withTableBroken('messages', () => get(`/admin/chats/${m.id}`))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'messages_fetch_failed' })
  })

  it('GET /admin/chats/:matchId includes isSeed and marks the real user\'s messages read in a fake chat', async () => {
    const m = await createMatch(seed.id, real.id)
    await msg(m.id, real.id, 'hi')
    await msg(m.id, seed.id, 'hello')

    const res = await get(`/admin/chats/${m.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().match.users).toEqual([
      { id: seed.id, name: 'Fake Sara', photo: null, isSeed: true },
      { id: real.id, name: 'Reza', photo: null, isSeed: false },
    ])
    const rows = await sql`select sender_id, read_at from messages order by body`
    expect(rows.find((r) => r.sender_id === real.id)!.read_at).not.toBeNull()
    expect(rows.find((r) => r.sender_id === seed.id)!.read_at).toBeNull()
  })

  describe('POST /admin/chats/:matchId/messages', () => {
    const send = (matchId: string, body: unknown) =>
      app.inject({ method: 'POST', url: `/admin/chats/${matchId}/messages`, headers, payload: { body } as any })

    it('sends as the seed participant and notifies the real user', async () => {
      const m = await createMatch(seed.id, real.id)

      const res = await send(m.id, ' hello there ')

      expect(res.statusCode).toBe(200)
      const out = res.json().message
      expect(out).toMatchObject({ senderId: seed.id, body: 'hello there', readAt: null })
      const [row] = await sql`select id, match_id, sender_id, body, type, created_at from messages`
      expect(row).toMatchObject({ id: out.id, match_id: m.id, sender_id: seed.id, body: 'hello there', type: 'text' })
      expect(out.createdAt).toBe(row.created_at)
      expect(deliverMessageNotification).toHaveBeenCalledWith(
        expect.objectContaining({ id: real.id, telegram_id: 999 }),
        seed.id, 'Fake Sara', 'hello there', m.id, expect.anything(),
      )
    })

    it('returns 400 no_fake_participant when neither participant is a seed', async () => {
      const m = await createMatch(sara.id, ali.id)
      const res = await send(m.id, 'hi')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'no_fake_participant' })
    })

    it('returns 400 empty_message for an empty/whitespace body', async () => {
      const res = await send(NO_MATCH, '   ')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'empty_message' })
    })

    it('returns 400 message_too_long for a body over 2000 characters', async () => {
      const res = await send(NO_MATCH, 'x'.repeat(2001))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'message_too_long' })
    })

    it('returns 404 match_not_found for an unknown or malformed match', async () => {
      for (const id of [NO_MATCH, 'nope']) {
        const res = await send(id, 'hi')
        expect(res.statusCode).toBe(404)
        expect(res.json()).toEqual({ error: 'match_not_found' })
      }
    })
  })

  describe('GET /admin/chats/unread-count', () => {
    const count = async () => (await get('/admin/chats/unread-count')).json()

    it('returns count 1 when a fake chat has an unread message from the real user', async () => {
      const m = await createMatch(seed.id, real.id)
      await msg(m.id, real.id, 'hi')
      await msg(m.id, real.id, 'hi again')
      expect(await count()).toEqual({ count: 1 })
    })

    it('returns count 0 when there are no seed users', async () => {
      const m = await createMatch(sara.id, ali.id)
      await msg(m.id, ali.id, 'hi')
      expect(await count()).toEqual({ count: 0 })
    })

    it('returns count 0 when the only unread message in a fake chat was sent by the seed, not the real user', async () => {
      const m = await createMatch(real.id, seed.id)
      await msg(m.id, seed.id, 'salam')
      expect(await count()).toEqual({ count: 0 })
    })

    it('ignores read messages, icebreaker rows and seed↔seed chats', async () => {
      const seed2 = await createUser({ name: 'Fake 2', is_seed: true, telegram_id: -2 })
      const m1 = await createMatch(seed.id, real.id)
      await msg(m1.id, real.id, 'read', { read_at: new Date().toISOString() })
      await msg(m1.id, real.id, 'q?', { type: 'icebreaker' })
      const m2 = await createMatch(seed.id, seed2.id)
      await msg(m2.id, seed2.id, 'hi')
      expect(await count()).toEqual({ count: 0 })
    })

    it('answers 0 (not 500) when the lookup fails, as before', async () => {
      const m = await createMatch(seed.id, real.id)
      await msg(m.id, real.id, 'hi')
      const res = await withTableBroken('messages', () => get('/admin/chats/unread-count'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ count: 0 })
    })
  })

  it('GET /admin/chats?filter=fake-unread returns only fake-unread matches, icebreakers excluded', async () => {
    const m = await createMatch(seed.id, real.id)
    await msg(m.id, real.id, 'hi there', { created_at: '2026-08-06T00:00:00Z' })
    await msg(m.id, real.id, 'q?', { type: 'icebreaker', created_at: '2026-08-07T00:00:00Z' })
    const other = await createMatch(sara.id, ali.id)
    await msg(other.id, ali.id, 'real chat')

    const res = await get('/admin/chats?filter=fake-unread')

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].matchId).toBe(m.id)
    expect(body.items[0].messageCount).toBe(1)
    expect(body.items[0].lastMessage).toEqual({ body: 'hi there', createdAt: '2026-08-06T00:00:00.000Z' })
  })

  it('GET /admin/chats?filter=fake-unread with nothing unread is an empty page', async () => {
    expect((await get('/admin/chats?filter=fake-unread')).json()).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it('GET /admin/chats?userId= lists only that user\'s chats with their sentCount; sent=1 keeps chats they wrote in', async () => {
    const wrote = await createMatch(sara.id, ali.id)
    const silent = await createMatch(sara.id, real.id)
    const iceOnly = await createMatch(sara.id, seed.id)
    await createMatch(ali.id, real.id)
    await msg(wrote.id, sara.id, 'hi')
    await msg(wrote.id, sara.id, 'there')
    await msg(wrote.id, ali.id, 'yo')
    await msg(silent.id, real.id, 'hello?')
    await msg(iceOnly.id, sara.id, 'Best trip?', { type: 'icebreaker' })

    const all = (await get(`/admin/chats?userId=${sara.id}`)).json()
    expect(all.total).toBe(3)
    const sentById = Object.fromEntries(all.items.map((c: any) => [c.matchId, c.sentCount]))
    expect(sentById).toEqual({ [wrote.id]: 2, [silent.id]: 0, [iceOnly.id]: 0 })

    const sent = (await get(`/admin/chats?userId=${sara.id}&sent=1`)).json()
    expect(sent).toMatchObject({ total: 1, page: 1, pageCount: 1 })
    expect(sent.items).toHaveLength(1)
    expect(sent.items[0]).toMatchObject({ matchId: wrote.id, sentCount: 2, messageCount: 3 })
  })

  it('GET /admin/chats?userId= paginates and rejects a non-uuid', async () => {
    for (let i = 0; i < 21; i++) {
      const u = await createUser({ name: `U${i}` })
      const m = await createMatch(sara.id, u.id)
      await msg(m.id, sara.id, `hi ${i}`)
    }
    const p2 = (await get(`/admin/chats?userId=${sara.id}&sent=1&page=2`)).json()
    expect(p2).toMatchObject({ total: 21, page: 2, pageCount: 2 })
    expect(p2.items).toHaveLength(1)
    expect((await get('/admin/chats?userId=nope')).statusCode).toBe(400)
  })
})
