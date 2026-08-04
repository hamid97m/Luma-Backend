import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { db } from '../src/db.js'
import { createTicket, shouldCaptureSupport, SUPPORT_CAPTURE_WINDOW_MS } from '../src/support/service.js'
import { chainable } from './admin-helpers.js'

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
  beforeEach(() => vi.clearAllMocks())

  it('rejects an empty body', async () => {
    const res = await createTicket('u1', '   ')
    expect(res).toEqual({ ok: false, error: 'empty_body' })
  })

  it('rejects a body over the cap', async () => {
    const res = await createTicket('u1', 'x'.repeat(2001))
    expect(res).toEqual({ ok: false, error: 'body_too_long' })
  })

  it('rejects when the user already has 5 open tickets', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return chainable({ count: 5, error: null })
      return chainable({ error: null })
    })
    const res = await createTicket('u1', 'help me')
    expect(res).toEqual({ ok: false, error: 'too_many_open_tickets' })
  })

  it('creates a ticket and its first message', async () => {
    const ticketInsert = vi.fn(() => chainable({ data: { id: 't1', created_at: 'now' }, error: null }))
    const msgInsert = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return { select: () => chainable({ count: 0, error: null }), insert: ticketInsert } as any
      }
      if (table === 'support_messages') return { insert: msgInsert } as any
      return chainable({ error: null })
    })
    const res = await createTicket('u1', '  hello  ')
    expect(res).toEqual({ ok: true, ticketId: 't1', createdAt: 'now' })
    expect((ticketInsert.mock.calls[0][0] as any)).toMatchObject({ user_id: 'u1', status: 'open', last_sender: 'user' })
    expect((msgInsert.mock.calls[0][0] as any)).toMatchObject({ ticket_id: 't1', sender: 'user', body: 'hello' })
  })
})
