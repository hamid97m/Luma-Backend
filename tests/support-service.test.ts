import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTicket, shouldCaptureSupport, SUPPORT_CAPTURE_WINDOW_MS } from '../src/support/service.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { failOn, failReadsOf, clearFailures } from './helpers/bot-support.js'

describe('shouldCaptureSupport', () => {
  const now = 1_000_000_000_000
  it('captures fresh plain text when awaiting', () => {
    expect(shouldCaptureSupport('my issue', new Date(now).toISOString(), now + 1000)).toBe(true)
  })
  it('ignores when not awaiting', () => {
    expect(shouldCaptureSupport('my issue', null, now)).toBe(false)
  })
  it('ignores commands', () => {
    expect(shouldCaptureSupport('/start', new Date(now).toISOString(), now)).toBe(false)
  })
  it('ignores empty text', () => {
    expect(shouldCaptureSupport(undefined, new Date(now).toISOString(), now)).toBe(false)
  })
  it('ignores a stale flag past the window', () => {
    expect(shouldCaptureSupport('hi', new Date(now).toISOString(), now + SUPPORT_CAPTURE_WINDOW_MS + 1)).toBe(false)
  })
})

describe('createTicket', () => {
  let user: Record<string, any>
  beforeEach(async () => {
    await resetDb()
    user = await createUser()
  })
  afterEach(clearFailures)

  it('rejects an empty body', async () => {
    const res = await createTicket(user.id, '   ')
    expect(res).toEqual({ ok: false, error: 'empty_body' })
  })

  it('rejects a body over the cap', async () => {
    const res = await createTicket(user.id, 'x'.repeat(2001))
    expect(res).toEqual({ ok: false, error: 'body_too_long' })
  })

  it('rejects when the user already has 5 open tickets', async () => {
    for (let i = 0; i < 5; i++) await insertRow('support_tickets', { user_id: user.id, status: 'open' })
    const res = await createTicket(user.id, 'help me')
    expect(res).toEqual({ ok: false, error: 'too_many_open_tickets' })
  })

  it('closed tickets do not count toward the open-ticket cap', async () => {
    for (let i = 0; i < 5; i++) await insertRow('support_tickets', { user_id: user.id, status: 'closed' })
    const res = await createTicket(user.id, 'help me')
    expect(res.ok).toBe(true)
  })

  it('creates a ticket and its first message', async () => {
    const res = await createTicket(user.id, '  hello  ')
    expect(res).toMatchObject({ ok: true })
    if (!res.ok) throw new Error('unreachable')
    const [ticket] = await sql`select * from support_tickets`
    expect(ticket).toMatchObject({ id: res.ticketId, user_id: user.id, status: 'open', last_sender: 'user' })
    expect(res.createdAt).toBe(ticket.created_at)
    const msgs = await sql`select ticket_id, sender, body from support_messages`
    expect(msgs).toEqual([{ ticket_id: res.ticketId, sender: 'user', body: 'hello' }])
  })

  it('returns create_failed when ticket insert fails', async () => {
    await failOn('support_tickets', 'insert')
    const res = await createTicket(user.id, 'help me')
    expect(res).toEqual({ ok: false, error: 'create_failed' })
  })

  it('returns create_failed and leaves no ticket when message insert fails', async () => {
    await failOn('support_messages', 'insert')
    const res = await createTicket(user.id, 'help me')
    expect(res).toEqual({ ok: false, error: 'create_failed' })
    expect(await sql`select id from support_tickets`).toHaveLength(0)
  })

  it('treats a failed open-ticket count as zero (old swallowed-error behaviour)', async () => {
    // Reads of support_tickets fail → count reads as 0; the insert then fails too → create_failed, not a throw.
    await failReadsOf('support_tickets')
    const res = await createTicket(user.id, 'help me')
    expect(res).toEqual({ ok: false, error: 'create_failed' })
  })
})
