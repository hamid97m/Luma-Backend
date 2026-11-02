import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let other: Record<string, any>
let match: Record<string, any>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
  other = await createUser({ name: 'Sara' })
  match = await createMatch(me.id, other.id)
  authAs(me)
})

function message(row: Record<string, unknown>) {
  return insertRow('messages', { match_id: match.id, sender_id: me.id, body: 'hi', ...row })
}

const list = async (query = '') => {
  const res = await app.inject({ method: 'GET', url: `/matches/${match.id}/messages${query}`, headers: AUTH })
  expect(res.statusCode).toBe(200)
  return res.json().messages as any[]
}

describe('GET /matches/:matchId/messages?after=', () => {
  it('returns only messages created after the given one', async () => {
    const m1 = await message({ body: 'one', created_at: '2026-11-03T10:00:00.000001Z' })
    await message({ body: 'two', created_at: '2026-11-03T10:00:00.000002Z' }) // same millisecond
    await message({ body: 'three', created_at: '2026-11-03T10:00:01Z' })
    expect((await list(`?after=${m1.id}`)).map((m) => m.body)).toEqual(['two', 'three'])
  })

  it('breaks created_at ties by id, consistently with the full list', async () => {
    const at = '2026-11-03T10:00:00Z'
    await message({ body: 'x', created_at: at })
    await message({ body: 'y', created_at: at })
    await message({ body: 'z', created_at: at })
    const full = await list()
    expect((await list(`?after=${full[0].id}`)).map((m) => m.id)).toEqual(full.slice(1).map((m) => m.id))
    expect(await list(`?after=${full[2].id}`)).toEqual([])
  })

  it('falls back to the full list for an unknown, malformed or foreign id', async () => {
    await message({ body: 'one', created_at: '2026-11-03T10:00:00Z' })
    await message({ body: 'two', created_at: '2026-11-03T10:00:01Z' })
    const elsewhere = await createMatch(other.id, (await createUser()).id)
    const foreign = await insertRow('messages', { match_id: elsewhere.id, sender_id: other.id, body: 'f' })
    for (const q of [`?after=${MISSING_UUID}`, '?after=nope', `?after=${foreign.id}`, '?after=']) {
      expect((await list(q)).map((m) => m.body)).toEqual(['one', 'two'])
    }
  })

  it('still marks the counterpart’s messages read', async () => {
    const mine = await message({ created_at: '2026-11-03T10:00:00Z' })
    const theirs = await message({ sender_id: other.id, created_at: '2026-11-03T10:00:01Z' })
    await list(`?after=${mine.id}`)
    const [row] = await sql`select read_at from messages where id = ${theirs.id}`
    expect(row.read_at).not.toBeNull()
  })

  it('returns the full message shape', async () => {
    const m = await message({ created_at: '2026-11-03T10:00:00Z' })
    await message({ body: 'next', created_at: '2026-11-03T10:00:01Z' })
    const [got] = await list(`?after=${m.id}`)
    expect(Object.keys(got).sort()).toEqual([
      'body', 'createdAt', 'editedAt', 'gift', 'icebreakerAnswer', 'id', 'readAt', 'replyToMessageId', 'senderId', 'type',
    ])
  })
})

describe('POST /matches/:matchId/read', () => {
  const read = (matchId = match.id, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url: `/matches/${matchId}/read`, headers })

  it('marks only the counterpart’s unread messages read (no body needed)', async () => {
    const mine = await message({})
    const theirs = await message({ sender_id: other.id })
    const res = await read()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const rows = await sql`select id, read_at from messages`
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.read_at]))
    expect(byId[theirs.id]).not.toBeNull()
    expect(byId[mine.id]).toBeNull()
  })

  it('keeps an existing read_at', async () => {
    const at = '2026-11-01T00:00:00.000Z'
    const theirs = await message({ sender_id: other.id, read_at: at })
    await read()
    const [row] = await sql`select read_at from messages where id = ${theirs.id}`
    expect(row.read_at).toBe(at)
  })

  it('401 without auth, 404 for a foreign / missing / malformed / blocked match', async () => {
    expect((await read(match.id, {})).statusCode).toBe(401)
    const foreign = await createMatch(other.id, (await createUser()).id)
    for (const id of [foreign.id, MISSING_UUID, 'nope']) {
      const res = await read(id)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    }
    await insertRow('blocks', { blocker_id: other.id, blocked_id: me.id })
    expect((await read()).statusCode).toBe(404)
  })
})
