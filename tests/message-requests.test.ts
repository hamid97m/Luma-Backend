import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn(),
  notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyMessageRequest: vi.fn().mockResolvedValue(undefined),
  notifyRequestAccepted: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { notifyMessageRequest, notifyNewMessage, notifyRequestAccepted } from '../src/bot.js'
import { createChatHub } from '../src/realtime/hub.js'
import { settleMessageWork } from '../src/messaging/inflight.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow, sql } from './helpers/db.js'

const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

let app: Awaited<ReturnType<typeof buildApp>>
let ali: Record<string, any>
let sara: Record<string, any>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await sql`update premium_config set premium_enabled = true`
  ali = await createUser({
    name: 'Ali', premium_until: new Date(Date.now() + 30 * DAY).toISOString(),
    icebreaker_prompt: 'Ali asks', icebreaker_answer: 'a',
  })
  sara = await createUser({
    name: 'Sara', gender: 'woman', looking_for: 'men',
    icebreaker_prompt: 'Sara asks', icebreaker_answer: 'b',
  })
})

afterEach(async () => {
  await settleMessageWork()
  await app.close()
})

type U = Record<string, any>
const call = (user: U, method: 'GET' | 'POST', url: string, payload?: any) => {
  authAs(user as any)
  return app.inject({ method, url, headers: AUTH, ...(payload ? { payload } : {}) })
}
const send = (from: U, to: U, message?: unknown) =>
  call(from, 'POST', '/discovery/direct-chat', { targetUserId: to.id, ...(message === undefined ? {} : { message }) })
const request = (over: Record<string, unknown> = {}) =>
  insertRow('message_requests', { sender_id: ali.id, recipient_id: sara.id, body: 'hello', ...over })
const requests = () => sql`select * from message_requests order by created_at`
const windowCount = async () =>
  (await sql`select direct_chat_window_count as n from users where id = ${ali.id}`)[0].n
const texts = async (matchId: string) =>
  (await sql`select sender_id, type, body from messages where match_id = ${matchId} order by created_at, id`)
    .map((m) => [m.sender_id === ali.id ? 'ali' : 'other', m.type, m.body])
const woman = (over: Record<string, unknown> = {}) => createUser({ gender: 'woman', looking_for: 'men', ...over })

describe('POST /discovery/direct-chat to a woman', () => {
  it('creates a pending request (no match), consumes quota, and notifies her', async () => {
    const res = await send(ali, sara, '  hi there  ')
    expect(res.statusCode).toBe(200)
    const [row] = await requests()
    expect(row).toMatchObject({ sender_id: ali.id, recipient_id: sara.id, body: 'hi there', status: 'pending', match_id: null })
    expect(res.json()).toEqual({
      request: { id: row.id, status: 'pending' },
      directChat: { remaining: 2, resetAt: expect.any(String) },
    })
    expect(await sql`select 1 from matches`).toHaveLength(0)
    await settleMessageWork()
    expect(notifyMessageRequest).toHaveBeenCalledTimes(1)
    expect(notifyMessageRequest).toHaveBeenCalledWith(sara.telegram_id, 'Ali', null)
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('400 message_required / message_too_long, nothing consumed', async () => {
    for (const m of [undefined, '', '   ', 5, null]) {
      const res = await send(ali, sara, m)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'message_required' })
    }
    const long = await send(ali, sara, 'x'.repeat(501))
    expect(long.statusCode).toBe(400)
    expect(long.json()).toEqual({ error: 'message_too_long' })
    expect((await send(ali, sara, 'x'.repeat(500))).statusCode).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await windowCount()).toBe(1)
  })

  it('a duplicate returns the existing request without a second slot or DM', async () => {
    const first = (await send(ali, sara, 'one')).json()
    const res = await send(ali, sara, 'two')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ request: first.request })
    expect((await requests()).map((r) => r.body)).toEqual(['one'])
    expect(await windowCount()).toBe(1)
    await settleMessageWork()
    expect(notifyMessageRequest).toHaveBeenCalledTimes(1)
  })

  it('a concurrent double tap creates one request and keeps one slot', async () => {
    authAs(ali as any)
    const res = await Promise.all([1, 2].map((n) => app.inject({
      method: 'POST', url: '/discovery/direct-chat', headers: AUTH, payload: { targetUserId: sara.id, message: `m${n}` },
    })))
    expect(res.map((r) => r.statusCode)).toEqual([200, 200])
    const rows = await requests()
    expect(rows).toHaveLength(1)
    for (const r of res) expect(r.json().request).toEqual({ id: rows[0].id, status: 'pending' })
    expect(await windowCount()).toBe(1)
  })

  it('403 too_many_pending at 10; ignored still count (it frees no slot), accepted/expired/blocked do not', async () => {
    for (let i = 0; i < 8; i++) await request({ recipient_id: (await woman()).id })
    await request({ recipient_id: (await woman()).id, status: 'ignored' })
    await request({ recipient_id: (await woman()).id, status: 'accepted' })
    const blocker = await woman()
    await request({ recipient_id: blocker.id })
    await insertRow('blocks', { blocker_id: blocker.id, blocked_id: ali.id })
    await request({ recipient_id: (await woman()).id, created_at: ago(8 * DAY) })
    expect((await send(ali, sara, 'tenth')).statusCode).toBe(200)
    const res = await send(ali, await woman(), 'eleventh')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'too_many_pending' })
    expect(await windowCount()).toBe(1)
  })

  it('quota: the 4th request in the window is refused', async () => {
    for (let i = 0; i < 3; i++) expect((await send(ali, await woman(), 'hi')).statusCode).toBe(200)
    const res = await send(ali, sara, 'hi')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'direct_chat_limit', resetAt: expect.any(String) })
    expect(await requests()).toHaveLength(3)
  })

  it('non-premium → 403 premium_required, no request', async () => {
    await sql`update users set premium_until = null where id = ${ali.id}`
    const res = await send(ali, sara, 'hi')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'premium_required' })
    expect(await requests()).toHaveLength(0)
  })

  it('an existing match opens the chat; no message needed, no request', async () => {
    const m = await createMatch(ali.id, sara.id)
    const [a, b] = [ali.id, sara.id].sort()
    await sql`update matches set user1_id = ${a}, user2_id = ${b} where id = ${m.id}`
    const res = await send(ali, sara)
    expect(res.json()).toEqual({ created: false, match: { id: m.id, matchedAt: m.created_at, user: { id: sara.id, name: 'Sara' } } })
    expect(await requests()).toHaveLength(0)
  })

  it.each([
    ['ignored', { status: 'ignored', decided_at: ago(1000) }],
    ['ignored long ago', { status: 'ignored', created_at: ago(90 * DAY) }],
    ['pending past 7 days', { created_at: ago(8 * DAY) }],
    ['expired', { status: 'expired', created_at: ago(90 * DAY) }],
  ])('one request ever: re-sending after %s answers pending, no new one, slot or DM', async (_n, over) => {
    const r = await request(over)
    const res = await send(ali, sara, 'hello??')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ request: { id: r.id, status: 'pending' } })
    expect((await requests()).map((x) => x.body)).toEqual(['hello'])
    expect(await windowCount()).toBe(0)
    await settleMessageWork()
    expect(notifyMessageRequest).not.toHaveBeenCalled()
  })

  it('ignore through the API, then re-send: same answer as before the ignore', async () => {
    const before = (await send(ali, sara, 'one')).json().request
    await call(sara, 'POST', `/requests/${before.id}/ignore`)
    expect((await send(ali, sara, 'two')).json()).toEqual({ request: before })
    expect(await windowCount()).toBe(1)
    expect((await call(sara, 'GET', '/requests')).json()).toEqual({ requests: [] })
  })

  it('the database allows one request per pair, whatever the status', async () => {
    await request({ status: 'ignored' })
    await expect(request()).rejects.toMatchObject({ code: '23505' })
    await request({ sender_id: sara.id, recipient_id: ali.id }) // the other direction is its own pair
  })

  it('woman → woman is a request too', async () => {
    const mina = await woman({ name: 'Mina', looking_for: 'women', premium_until: ali.premium_until })
    const res = await send(mina, sara, 'hi')
    expect(res.statusCode).toBe(200)
    expect(res.json().request.status).toBe('pending')
    expect(await sql`select 1 from matches`).toHaveLength(0)
  })

  it('a rejected call never burns a daily slot (message, duplicate, cap)', async () => {
    await request()
    await send(ali, sara)
    await send(ali, sara, 'dup')
    for (let i = 0; i < 9; i++) await request({ recipient_id: (await woman()).id })
    const next = await woman()
    expect((await send(ali, next)).json()).toEqual({ error: 'message_required' })
    expect((await send(ali, next, 'hi')).json()).toEqual({ error: 'too_many_pending' })
    expect(await windowCount()).toBe(0)
  })

  it('the slot comes back when the insert fails', async () => {
    await sql`alter table message_requests add constraint boom check (body <> 'boom')`
    try {
      const res = await send(ali, sara, 'boom')
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'request_failed' })
      expect(await windowCount()).toBe(0)
    } finally {
      await sql`alter table message_requests drop constraint boom`
    }
  })

  it('403 blocked', async () => {
    await insertRow('blocks', { blocker_id: sara.id, blocked_id: ali.id })
    expect((await send(ali, sara, 'hi')).json()).toEqual({ error: 'blocked' })
    expect(await requests()).toHaveLength(0)
  })
})

describe('POST /discovery/direct-chat — instant targets', () => {
  it('a seed woman auto-accepts; his message follows the icebreakers', async () => {
    const seed = await woman({ name: 'Fake', is_seed: true, telegram_id: -5, icebreaker_prompt: 'Q', icebreaker_answer: 'A' })
    const res = await send(ali, seed, 'hi fake')
    expect(res.json()).toMatchObject({ created: true, match: { user: { id: seed.id, name: 'Fake' } }, directChat: { remaining: 2 } })
    expect(await texts(res.json().match.id)).toEqual([
      ['other', 'icebreaker', 'Q'], ['ali', 'icebreaker', 'Ali asks'], ['ali', 'text', 'hi fake'],
    ])
    expect(await requests()).toHaveLength(0)
    expect((await send(ali, await woman({ is_seed: true, telegram_id: -6 }))).json().created).toBe(true)
  })

  it('woman → man stays instant, with or without a message; he is notified of the message', async () => {
    const res = await send(sara, ali, 'hey Ali')
    expect(res.json()).toMatchObject({ created: true, match: { matchedAt: expect.any(String), user: { id: ali.id } } })
    expect((await texts(res.json().match.id)).at(-1)).toEqual(['other', 'text', 'hey Ali'])
    await settleMessageWork()
    expect(notifyNewMessage).toHaveBeenCalledTimes(1)

    const bob = await createUser({ name: 'Bob' })
    const plain = await send(sara, bob)
    expect(plain.statusCode).toBe(200)
    expect((await texts(plain.json().match.id)).filter((m) => m[1] === 'text')).toEqual([])
  })

  it('an over-long message is refused before anything is created', async () => {
    const res = await send(sara, ali, 'x'.repeat(501))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'message_too_long' })
    expect(await sql`select 1 from matches`).toHaveLength(0)
  })
})

describe('GET /requests', () => {
  it('lists her pending requests newest first with a profile card', async () => {
    await sql`update users set bio = 'b', location = 'Tehran', interests = ${['music']} where id = ${ali.id}`
    const p1 = await createPhoto(ali.id, 1)
    const p0 = await createPhoto(ali.id, 0)
    const bob = await createUser({ name: 'Bob' })
    const a = await request({ created_at: ago(5000) })
    const b = await request({ sender_id: bob.id, body: 'yo' })
    const res = await call(sara, 'GET', '/requests')
    expect(res.statusCode).toBe(200)
    expect(res.json().requests.map((r: any) => r.id)).toEqual([b.id, a.id])
    expect(res.json().requests[1]).toEqual({
      id: a.id, body: 'hello', createdAt: expect.any(String),
      user: {
        id: ali.id, name: 'Ali', age: 28, bio: 'b', location: 'Tehran', interests: ['music'],
        photos: [p0.url, p1.url], premium: true,
      },
    })
  })

  it('hides decided, expired and unavailable senders, and other people\'s requests', async () => {
    const mk = async (over: Record<string, unknown>) => request({ sender_id: (await createUser(over)).id })
    await mk({ deleted_at: ago(1) })
    await mk({ banned_at: ago(1) })
    await mk({ paused_at: ago(1) })
    const blocker = await createUser()
    await request({ sender_id: blocker.id })
    await insertRow('blocks', { blocker_id: blocker.id, blocked_id: sara.id })
    const blocked = await createUser()
    await request({ sender_id: blocked.id })
    await insertRow('blocks', { blocker_id: sara.id, blocked_id: blocked.id })
    await request({ sender_id: (await createUser()).id, created_at: ago(8 * DAY) })
    await request({ sender_id: (await createUser()).id, status: 'ignored' })
    await request({ recipient_id: (await woman()).id })
    expect((await call(sara, 'GET', '/requests')).json()).toEqual({ requests: [] })
  })

  it('401 without auth', async () => {
    for (const url of ['/requests', '/requests/sent']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
  })
})

describe('GET /requests/sent', () => {
  it('lists waiting requests; an ignored one keeps waiting until it expires', async () => {
    const photo = await createPhoto(sara.id)
    const pending = await request({ created_at: ago(3000) })
    const ignored = await request({ recipient_id: (await woman({ name: 'Mina' })).id, status: 'ignored', created_at: ago(2000) })
    await request({ recipient_id: (await woman()).id, status: 'accepted' })
    await request({ recipient_id: (await woman()).id, status: 'ignored', created_at: ago(8 * DAY) })
    await request({ recipient_id: (await woman({ deleted_at: ago(1) })).id })
    const res = await call(ali, 'GET', '/requests/sent')
    expect(res.json().requests.map((r: any) => r.id)).toEqual([ignored.id, pending.id])
    expect(res.json().requests[1]).toEqual({
      id: pending.id, body: 'hello', createdAt: expect.any(String),
      user: { id: sara.id, name: 'Sara', photo: photo.url },
    })
    expect(JSON.stringify(res.json())).not.toContain('ignored')
  })

  it('ignoring changes nothing in the list; pending and ignored both drop out at 7 days', async () => {
    const r = await request()
    const before = (await call(ali, 'GET', '/requests/sent')).json()
    expect(before.requests).toHaveLength(1)
    await call(sara, 'POST', `/requests/${r.id}/ignore`)
    expect((await call(ali, 'GET', '/requests/sent')).json()).toEqual(before)
    for (const status of ['pending', 'ignored']) {
      await sql`update message_requests set status = ${status}, created_at = ${ago(7 * DAY + 1000)}`
      expect((await call(ali, 'GET', '/requests/sent')).json()).toEqual({ requests: [] })
    }
  })

  it('POST /block removes the request from both lists', async () => {
    const r = await request()
    expect((await call(sara, 'POST', '/block', { userId: ali.id })).statusCode).toBe(200)
    expect((await call(sara, 'GET', '/requests')).json()).toEqual({ requests: [] })
    expect((await call(ali, 'GET', '/requests/sent')).json()).toEqual({ requests: [] })
    expect((await call(sara, 'POST', `/requests/${r.id}/accept`)).json()).toEqual({ error: 'not_available' })
  })

  it('POST /reports works on a request sender she has no match with', async () => {
    await request()
    const res = await call(sara, 'POST', '/reports', { reportedUserId: ali.id, context: 'discovery', reason: 'harassment' })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /requests/:id/accept', () => {
  const accept = (id: string, as = sara) => call(as, 'POST', `/requests/${id}/accept`)

  it('creates the match, icebreakers then his message, and tells him', async () => {
    const r = await request()
    const res = await accept(r.id)
    expect(res.statusCode).toBe(200)
    const [m] = await sql`select * from matches`
    expect(res.json()).toEqual({
      match: { id: m.id, matchedAt: m.created_at, user: { id: ali.id, name: 'Ali' } },
    })
    expect([m.user1_id, m.user2_id]).toEqual([ali.id, sara.id].sort())
    expect(await texts(m.id)).toEqual([
      ['ali', 'icebreaker', 'Ali asks'], ['other', 'icebreaker', 'Sara asks'], ['ali', 'text', 'hello'],
    ])
    expect((await requests())[0]).toMatchObject({ status: 'accepted', match_id: m.id, decided_at: expect.anything() })
    await settleMessageWork()
    expect(notifyRequestAccepted).toHaveBeenCalledTimes(1)
    expect(notifyRequestAccepted).toHaveBeenCalledWith(ali.telegram_id, 'Sara', m.id, null)
  })

  it('a match made meanwhile is reused, without new icebreakers', async () => {
    const r = await request()
    const [a, b] = [ali.id, sara.id].sort()
    const m = await createMatch(a, b)
    expect((await accept(r.id)).json().match.id).toBe(m.id)
    expect(await texts(m.id)).toEqual([['ali', 'text', 'hello']])
  })

  it('a double accept delivers the message once', async () => {
    const r = await request()
    authAs(sara as any)
    const res = await Promise.all([1, 2].map(() =>
      app.inject({ method: 'POST', url: `/requests/${r.id}/accept`, headers: AUTH })))
    expect(res.map((x) => x.statusCode).sort()).toEqual([200, 409])
    expect(res.find((x) => x.statusCode === 409)!.json()).toEqual({ error: 'already_handled' })
    expect(await sql`select 1 from messages where type = 'text'`).toHaveLength(1)
  })

  it('404 for someone else\'s, unknown or malformed id', async () => {
    const r = await request()
    for (const [id, as] of [[r.id, ali], ['00000000-0000-0000-0000-000000000000', sara], ['nope', sara]] as const) {
      const res = await accept(id, as)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'request_not_found' })
    }
    expect((await requests())[0].status).toBe('pending')
  })

  it('410 not_available after 7 days; retired as expired', async () => {
    const r = await request({ created_at: ago(8 * DAY) })
    const res = await accept(r.id)
    expect(res.statusCode).toBe(410)
    expect(res.json()).toEqual({ error: 'not_available' })
    expect((await requests())[0].status).toBe('expired')
    expect(await sql`select 1 from matches`).toHaveLength(0)
  })

  it('410 not_available for a deleted, banned, paused or blocked sender; retired', async () => {
    const gone = [{ deleted_at: ago(1) }, { banned_at: ago(1) }, { paused_at: ago(1) }]
    const ids = []
    for (const over of gone) ids.push((await request({ sender_id: (await createUser(over)).id })).id)
    ids.push((await request()).id)
    await insertRow('blocks', { blocker_id: ali.id, blocked_id: sara.id })
    for (const id of ids) {
      const res = await accept(id)
      expect(res.statusCode).toBe(410)
      expect(res.json()).toEqual({ error: 'not_available' })
    }
    expect((await requests()).map((r) => r.status)).toEqual(['ignored', 'ignored', 'ignored', 'ignored'])
    expect(await sql`select 1 from matches`).toHaveLength(0)
  })
})

describe('POST /requests/:id/ignore', () => {
  it('marks it ignored, silently; a second decision is 409', async () => {
    const r = await request()
    const res = await call(sara, 'POST', `/requests/${r.id}/ignore`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await requests())[0]).toMatchObject({ status: 'ignored', decided_at: expect.anything() })
    expect((await call(sara, 'GET', '/requests')).json()).toEqual({ requests: [] })
    for (const a of ['ignore', 'accept']) expect((await call(sara, 'POST', `/requests/${r.id}/${a}`)).statusCode).toBe(409)
    await settleMessageWork()
    expect(notifyRequestAccepted).not.toHaveBeenCalled()
    expect(await sql`select 1 from matches`).toHaveLength(0)
  })

  it('only the recipient can ignore', async () => {
    const r = await request()
    expect((await call(ali, 'POST', `/requests/${r.id}/ignore`)).statusCode).toBe(404)
    expect((await requests())[0].status).toBe('pending')
  })
})

describe('GET /discovery', () => {
  const seen = async () => (await call(ali, 'GET', '/discovery')).json().profiles as any[]

  it('hides everyone he ever sent a request to, any status, any age', async () => {
    await createPhoto(sara.id)
    expect((await seen()).map((p) => p.id)).toEqual([sara.id])
    const r = await request()
    expect(await seen()).toEqual([])
    for (const status of ['ignored', 'accepted', 'expired', 'pending']) {
      await sql`update message_requests set status = ${status}, created_at = ${ago(90 * DAY)} where id = ${r.id}`
      expect(await seen(), status).toEqual([])
    }
  })

  it('messageRequest: true for women (seeds too — it must not reveal them), false for men', async () => {
    await sql`update users set looking_for = 'both' where id = ${ali.id}`
    const seed = await woman({ is_seed: true, telegram_id: -7, locale: null })
    const bob = await createUser({ looking_for: 'both' })
    for (const u of [sara, seed, bob]) await createPhoto(u.id)
    const flags = Object.fromEntries((await seen()).map((p) => [p.id, p.messageRequest]))
    expect(flags).toEqual({ [sara.id]: true, [seed.id]: true, [bob.id]: false })
  })
})

describe('realtime', () => {
  it('the hub sends `request` to the recipient only; junk is dropped', () => {
    const hub = createChatHub({ loadMessages: vi.fn(), pairVisible: vi.fn(), loadCounterparts: async () => [] } as any)
    const stream = () => { const chunks: string[] = []; return { chunks, write: (c: string) => { chunks.push(c) }, close: () => {} } }
    const hers = stream()
    const his = stream()
    hub.addStream('her', hers as any)
    hub.addStream('him', his as any)
    for (const junk of ['nope', 'null', '{"to":"her"}']) hub.handleRequest(junk)
    hub.handleRequest(JSON.stringify({ requestId: 'r1', to: 'her' }))
    expect(hers.chunks).toEqual(['event: request\ndata: {"requestId":"r1"}\n\n'])
    expect(his.chunks).toEqual([])
  })

  it('publishes the new request on luma_request', async () => {
    const got: string[] = []
    const sub = await sql.listen('luma_request', (p) => { got.push(p) })
    const id = (await send(ali, sara, 'hi')).json().request.id
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(JSON.parse(got[0])).toEqual({ requestId: id, to: sara.id })
    await sub.unlisten()
  })
})
