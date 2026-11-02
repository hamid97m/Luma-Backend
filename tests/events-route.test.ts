import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { chatHub, loadCounterparts } from '../src/realtime/hub.js'
import { typingTargets } from '../src/realtime/typing.js'
import { startChatListener } from '../src/realtime/listener.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

// GET /events over a real socket (inject can't stream), with the real LISTEN
// connection feeding the shared hub.

let app: Awaited<ReturnType<typeof buildApp>>
let base: string
let me: Record<string, any>
let other: Record<string, any>
let match: Record<string, any>
const controllers: AbortController[] = []

const GRACE_MS = 150

beforeAll(async () => {
  chatHub.setPresenceGraceMs(GRACE_MS)
  startChatListener({ info: () => {}, warn: () => {} })
  // Let the LISTEN land before any test inserts.
  const end = Date.now() + 3000
  while (Date.now() < end) {
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where query ilike 'listen%luma_chat%'`
    if (n > 0) break
    await new Promise((r) => setTimeout(r, 20))
  }
})

beforeEach(async () => {
  await resetDb()
  typingTargets.clear()
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
  me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
  other = await createUser({ name: 'Sara' })
  match = await createMatch(me.id, other.id)
  authAs(me)
})

afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort()
  await app.close()
})


async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function open(headers: Record<string, string> = AUTH) {
  const ctrl = new AbortController()
  controllers.push(ctrl)
  const res = await fetch(`${base}/events`, { headers, signal: ctrl.signal })
  return { res, ctrl, reader: res.body ? stream(res.body) : null }
}

/** Accumulates the SSE text; `until(fn)` reads until fn(text) is true. */
function stream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  return {
    get text() { return text },
    async until(pred: (t: string) => boolean, ms = 3000): Promise<string> {
      const deadline = Date.now() + ms
      while (!pred(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; got: ${JSON.stringify(text)}`)
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
        ])
        if (chunk === null) continue
        if (chunk.done) return text
        text += decoder.decode(chunk.value, { stream: true })
      }
      return text
    },
  }
}

const parse = (text: string) =>
  text.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => {
    const [ev, data] = b.split('\n')
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) }
  })

describe('GET /events', () => {
  it('401 without auth', async () => {
    const res = await fetch(`${base}/events`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'missing_auth' })
  })

  it('opens an SSE stream: headers (incl. CORS), retry hint, then `ready`', async () => {
    // An allowed origin (WEB_URL when set; any origin otherwise) gets CORS headers.
    const origin = process.env.WEB_URL?.replace(/\/+$/, '') ?? 'https://app.example'
    const { res, reader } = await open({ ...AUTH, origin })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect([origin, '*']).toContain(res.headers.get('access-control-allow-origin'))
    const text = await reader!.until((t) => t.includes('event: ready'))
    expect(text.startsWith('retry: 3000\n\n')).toBe(true)
    expect(parse(text)).toEqual([{ event: 'ready', data: {} }])
    expect(chatHub.streamCount(me.id)).toBe(1)
  })

  it('is exempt from the global rate limit', async () => {
    const { res } = await open()
    expect(res.headers.get('x-ratelimit-limit')).toBeNull()
  })

  it('pushes a new message, its edit and its delete live', async () => {
    const { reader } = await open()
    await reader!.until((t) => t.includes('event: ready'))

    const m = await insertRow('messages', { match_id: match.id, sender_id: other.id, body: 'salam' })
    await reader!.until((t) => t.includes('event: message\n'))
    await sql`update messages set body = 'edited', edited_at = now() where id = ${m.id}`
    await reader!.until((t) => t.includes('event: message_updated'))
    await sql`delete from messages where id = ${m.id}`
    const text = await reader!.until((t) => t.includes('event: message_deleted'))

    const evs = parse(text).filter((e) => e.event !== 'ready' && e.event !== 'resync')
    expect(evs.map((e) => e.event)).toEqual(['message', 'message_updated', 'message_deleted'])
    expect(evs[0].data).toMatchObject({ matchId: match.id, message: { id: m.id, senderId: other.id, body: 'salam', type: 'text', readAt: null } })
    expect(evs[1].data.message).toMatchObject({ id: m.id, body: 'edited' })
    expect(evs[2].data).toEqual({ matchId: match.id, messageId: m.id })
  })

  it('POST /typing reaches the counterpart\'s stream as `typing`, not the typer\'s', async () => {
    const mine = await open()
    await mine.reader!.until((t) => t.includes('event: ready'))
    authAs(other)
    const theirs = await open()
    await theirs.reader!.until((t) => t.includes('event: ready'))
    await until(() => chatHub.streamCount(other.id) === 1)

    authAs(me)
    const res = await fetch(`${base}/matches/${match.id}/typing`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(200)
    const text = await theirs.reader!.until((t) => t.includes('event: typing'))
    expect(parse(text).filter((e) => e.event === 'typing')).toEqual([
      { event: 'typing', data: { matchId: match.id, userId: me.id } },
    ])
    await new Promise((r) => setTimeout(r, 200))
    expect(mine.reader!.text).not.toContain('event: typing')
  })

  it('withholds events when the pair is blocked', async () => {
    await insertRow('blocks', { blocker_id: other.id, blocked_id: me.id })
    const { reader } = await open()
    await reader!.until((t) => t.includes('event: ready'))
    await insertRow('messages', { match_id: match.id, sender_id: other.id, body: 'hidden' })
    await new Promise((r) => setTimeout(r, 300))
    expect(reader!.text).not.toContain('hidden')
  })

  it('unregisters the stream when the client disconnects', async () => {
    const { reader, ctrl } = await open()
    await reader!.until((t) => t.includes('event: ready'))
    expect(chatHub.streamCount(me.id)).toBe(1)
    ctrl.abort()
    const end = Date.now() + 2000
    while (chatHub.streamCount(me.id) > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    expect(chatHub.streamCount(me.id)).toBe(0)
  })

  it('a 4th concurrent stream closes the oldest', async () => {
    const first = await open()
    await first.reader!.until((t) => t.includes('event: ready'))
    for (let i = 0; i < 3; i++) {
      const s = await open()
      await s.reader!.until((t) => t.includes('event: ready'))
    }
    expect(chatHub.streamCount(me.id)).toBe(3)
    // The evicted stream is ended by the server: the reader reaches `done`.
    let ended = false
    await first.reader!.until(() => false, 1000).then(() => { ended = true }, () => {})
    expect(ended).toBe(true)
  })
})

describe('presence over GET /events', () => {
  const presence = (text: string) => parse(text).filter((e) => e.event === 'presence')

  /** Open a stream as `user` and wait for `ready`. */
  async function connect(user: Record<string, any>) {
    authAs(user)
    const s = await open()
    await s.reader!.until((t) => t.includes('event: ready'))
    return s
  }

  it('the counterpart sees me come online, then go offline after the grace period', async () => {
    const theirs = await connect(other)
    const mine = await connect(me)

    let text = await theirs.reader!.until((t) => presence(t).length >= 1)
    expect(presence(text)).toEqual([{ event: 'presence', data: { userId: me.id, online: true } }])

    mine.ctrl.abort()
    await until(() => chatHub.streamCount(me.id) === 0)
    expect(chatHub.isOnline(me.id)).toBe(true) // grace
    await new Promise((r) => setTimeout(r, GRACE_MS / 3))
    expect(presence(theirs.reader!.text)).toHaveLength(1)

    text = await theirs.reader!.until((t) => presence(t).length >= 2)
    expect(presence(text)[1]).toEqual({ event: 'presence', data: { userId: me.id, online: false } })
    expect(chatHub.isOnline(me.id)).toBe(false)
    expect(presence(mine.reader!.text).filter((e) => e.data.userId === me.id)).toEqual([]) // never about myself
  })

  it('a newly opened stream gets the online counterparts right after `ready`', async () => {
    const third = await createUser({ name: 'Third' })
    await createMatch(third.id, me.id)
    await connect(other) // online
    // `third` is matched but offline; nobody else is visible.
    const mine = await connect(me)
    const text = await mine.reader!.until((t) => presence(t).length >= 1)
    await new Promise((r) => setTimeout(r, 200))
    const evs = parse(mine.reader!.text).map((e) => e.event)
    expect(evs.indexOf('ready')).toBeLessThan(evs.indexOf('presence'))
    expect(presence(text)).toEqual([{ event: 'presence', data: { userId: other.id, online: true } }])
    expect(presence(mine.reader!.text)).toHaveLength(1)
  })

  it('the snapshot includes a counterpart still inside the grace period', async () => {
    const theirs = await connect(other)
    theirs.ctrl.abort()
    await until(() => chatHub.streamCount(other.id) === 0)
    expect(chatHub.isOnline(other.id)).toBe(true)
    const mine = await connect(me)
    const text = await mine.reader!.until((t) => presence(t).length >= 1)
    expect(presence(text)[0]).toEqual({ event: 'presence', data: { userId: other.id, online: true } })
  })

  it('GET /matches reports the counterpart online while their stream is open', async () => {
    await connect(other)
    authAs(me)
    const res = await fetch(`${base}/matches`, { headers: AUTH })
    const [row] = (await res.json()).matches
    expect(row.user).toMatchObject({ id: other.id, online: true })
  })

  it('sends no presence across a block (transition or snapshot)', async () => {
    await insertRow('blocks', { blocker_id: me.id, blocked_id: other.id })
    const theirs = await connect(other)
    const mine = await connect(me)
    await new Promise((r) => setTimeout(r, 300))
    expect(presence(theirs.reader!.text)).toEqual([])
    expect(presence(mine.reader!.text)).toEqual([])
  })
})

// `me`, `other` and their match come from the file-level beforeEach.
describe('loadCounterparts', () => {
  it('lists the other user of each match, either column order', async () => {
    const third = await createUser({ name: 'Third' })
    await createMatch(third.id, me.id)
    expect((await loadCounterparts(me.id)).sort()).toEqual([other.id, third.id].sort())
    expect(await loadCounterparts(other.id)).toEqual([me.id])
  })

  it('excludes deleted counterparts and blocks either way', async () => {
    const gone = await createUser({ name: 'Gone', deleted_at: new Date().toISOString() })
    const blocker = await createUser({ name: 'Blocker' })
    const blocked = await createUser({ name: 'Blocked' })
    await createMatch(me.id, gone.id)
    await createMatch(me.id, blocker.id)
    await createMatch(me.id, blocked.id)
    await insertRow('blocks', { blocker_id: blocker.id, blocked_id: me.id })
    await insertRow('blocks', { blocker_id: me.id, blocked_id: blocked.id })
    expect(await loadCounterparts(me.id)).toEqual([other.id])
  })

  it('returns nobody for a deleted user', async () => {
    await sql`update users set deleted_at = now() where id = ${me.id}`
    expect(await loadCounterparts(me.id)).toEqual([])
  })
})
