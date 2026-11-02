import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

// The 0001_messages_notify trigger: every messages insert/update/delete
// NOTIFYs 'luma_chat' with ids only.

const received: any[] = []
let unlisten: () => Promise<void>

beforeAll(async () => {
  const meta = await sql.listen('luma_chat', (payload) => received.push(JSON.parse(payload)))
  unlisten = meta.unlisten
})
afterAll(async () => {
  await unlisten?.()
})

let a: Record<string, any>
let b: Record<string, any>
let match: Record<string, any>

beforeEach(async () => {
  await resetDb()
  a = await createUser()
  b = await createUser()
  match = await createMatch(a.id, b.id)
  received.length = 0
})

/** NOTIFY is async to the listener connection — wait until `n` arrived (or time out). */
async function waitFor(n: number, ms = 2000) {
  const end = Date.now() + ms
  while (received.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  return received
}
const quiet = () => new Promise((r) => setTimeout(r, 150))

describe('messages NOTIFY trigger', () => {
  it('fires on INSERT with op, ids and both participants — never the body', async () => {
    const m = await insertRow('messages', { match_id: match.id, sender_id: a.id, body: 'secret text' })
    const [n] = await waitFor(1)
    expect(n).toEqual({ op: 'INSERT', id: m.id, matchId: match.id, u1: a.id, u2: b.id })
    expect(JSON.stringify(received)).not.toContain('secret text')
  })

  it('fires on UPDATE (edit / read receipt) and DELETE', async () => {
    const m = await insertRow('messages', { match_id: match.id, sender_id: a.id, body: 'hi' })
    await sql`update messages set read_at = now() where id = ${m.id}`
    await sql`delete from messages where id = ${m.id}`
    const got = await waitFor(3)
    expect(got.map((n) => n.op)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    expect(got.every((n) => n.id === m.id && n.matchId === match.id && n.u1 === a.id && n.u2 === b.id)).toBe(true)
  })

  it('stays silent for an UPDATE that changes nothing', async () => {
    const m = await insertRow('messages', { match_id: match.id, sender_id: a.id, body: 'hi' })
    await waitFor(1)
    await sql`update messages set body = body where id = ${m.id}`
    await quiet()
    expect(received.map((n) => n.op)).toEqual(['INSERT'])
  })

  it('stays silent when messages cascade from a deleted match', async () => {
    await insertRow('messages', { match_id: match.id, sender_id: a.id, body: 'hi' })
    await waitFor(1)
    await sql`delete from matches where id = ${match.id}`
    await quiet()
    expect(received.map((n) => n.op)).toEqual(['INSERT'])
    expect((await sql`select count(*)::int as n from messages`)[0].n).toBe(0)
  })
})
