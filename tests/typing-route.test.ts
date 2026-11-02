import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { startChatListener } from '../src/realtime/listener.js'
import { typingTargets, TYPING_CHANNEL } from '../src/realtime/typing.js'
import type { ChatHub } from '../src/realtime/hub.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let other: Record<string, any>
let match: Record<string, any>

// Every luma_typing payload published in this worker's database.
const published: string[] = []

/** Wait until a LISTEN on `channel` has been issued (postgres.js shares one
 *  listen connection, so pg_stat_activity shows its latest LISTEN). */
async function listening(channel: string) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where query ilike ${'listen%' + channel + '%'}`
    if (n > 0) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no LISTEN on ${channel}`)
}

async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  await sql.listen(TYPING_CHANNEL, (p) => { published.push(p) })
  await listening(TYPING_CHANNEL)
})

beforeEach(async () => {
  await resetDb()
  typingTargets.clear()
  published.length = 0
  app = await buildApp()
  me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
  other = await createUser({ name: 'Sara' })
  match = await createMatch(me.id, other.id)
  authAs(me)
})

afterEach(async () => {
  await app.close()
})

const ping = (matchId = match.id, headers: Record<string, string> = AUTH) =>
  app.inject({ method: 'POST', url: `/matches/${matchId}/typing`, headers })

describe('POST /matches/:matchId/typing', () => {
  it('200 { ok: true } body-less, and publishes {matchId, from, to} on luma_typing', async () => {
    const res = await ping()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await until(() => published.length > 0)
    expect(JSON.parse(published[0])).toEqual({ matchId: match.id, from: me.id, to: other.id })
  })

  it('works from either side of the match', async () => {
    authAs(other)
    expect((await ping()).statusCode).toBe(200)
    await until(() => published.length > 0)
    expect(JSON.parse(published[0])).toEqual({ matchId: match.id, from: other.id, to: me.id })
  })

  it('401 without auth', async () => {
    const res = await ping(match.id, {})
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_auth' })
  })

  it('404 match_not_found: unknown, malformed, not a participant, blocked, deleted counterpart', async () => {
    const stranger = await createUser({ name: 'X' })
    const third = await createUser({ name: 'Y' })
    const foreign = await createMatch(stranger.id, third.id)
    const blockedWith = await createUser({ name: 'B' })
    const blockedMatch = await createMatch(me.id, blockedWith.id)
    await insertRow('blocks', { blocker_id: blockedWith.id, blocked_id: me.id })
    const gone = await createUser({ name: 'G', deleted_at: new Date().toISOString() })
    const goneMatch = await createMatch(me.id, gone.id)

    for (const id of [MISSING_UUID, 'not-a-uuid', foreign.id, blockedMatch.id, goneMatch.id]) {
      const res = await ping(id)
      expect(res.statusCode, id).toBe(404)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    }
    expect(typingTargets.size).toBe(0) // negatives are never cached
    await new Promise((r) => setTimeout(r, 100))
    expect(published).toEqual([])
  })

  it('caches the counterpart: later pings skip the match lookup (until cleared / TTL)', async () => {
    expect((await ping()).statusCode).toBe(200)
    expect(typingTargets.get(match.id, me.id)).toBe(other.id)
    // The lookup would now say 404 — the cached entry still answers.
    await insertRow('blocks', { blocker_id: other.id, blocked_id: me.id })
    expect((await ping()).statusCode).toBe(200)
    typingTargets.clear()
    expect((await ping()).statusCode).toBe(404)
  })

  it('a usable match after an earlier 404 is not stuck as negative', async () => {
    const b = await insertRow('blocks', { blocker_id: other.id, blocked_id: me.id })
    expect((await ping()).statusCode).toBe(404)
    await sql`delete from blocks where id = ${b.id}`
    expect((await ping()).statusCode).toBe(200)
  })

  it('has its own rate limit (40/min), independent of the global 300/hour bucket', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await ping()
      expect(res.statusCode).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('40')
    }
    const limited = await ping()
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toEqual({ error: 'rate_limited' })

    // The global bucket was never touched by the 41 pings.
    const other = await app.inject({ method: 'GET', url: `/matches/${match.id}/messages`, headers: AUTH })
    expect(other.statusCode).toBe(200)
    expect(other.headers['x-ratelimit-limit']).toBe('300')
    expect(other.headers['x-ratelimit-remaining']).toBe('299')
  })
})

describe('global rate limit', () => {
  it('answers 429 rate_limited (not 500) once the 300/hour bucket is spent', async () => {
    for (let i = 0; i < 300; i++) {
      const res = await app.inject({ method: 'GET', url: `/matches/${match.id}/messages`, headers: AUTH })
      expect(res.statusCode).toBe(200)
    }
    const res = await app.inject({ method: 'GET', url: `/matches/${match.id}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'rate_limited' })
    // Typing pings still go through — their own bucket.
    expect((await ping()).statusCode).toBe(200)
  })
})

describe('listener', () => {
  it('routes luma_typing to hub.handleTyping and luma_chat to hub.handleNotify', async () => {
    const hub = { handleNotify: vi.fn(), handleTyping: vi.fn(), resyncAll: vi.fn() }
    const info = vi.fn()
    startChatListener({ info, warn: () => {} }, hub as unknown as ChatHub)
    // Both onlisten callbacks fired.
    await until(() => info.mock.calls.length >= 2)
    expect(info.mock.calls.map((c) => c[1]).sort()).toEqual(['luma_chat', 'luma_typing'])

    await sql`select pg_notify('luma_typing', 'typing-payload')`
    await sql`select pg_notify('luma_chat', 'chat-payload')`
    await until(() => hub.handleTyping.mock.calls.length > 0 && hub.handleNotify.mock.calls.length > 0)
    expect(hub.handleTyping.mock.calls).toEqual([['typing-payload']])
    expect(hub.handleNotify.mock.calls).toEqual([['chat-payload']])
    expect(hub.resyncAll).toHaveBeenCalledTimes(1) // typing listen doesn't resync
  })
})
