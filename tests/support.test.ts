import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-1'

function mockAuthUserLookup() {
  // server.ts auth preHandler: users lookup by telegram_id
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('support routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    app = await buildApp()
  })

  it('creates a ticket', async () => {
    mockAuthUserLookup()
    const ticketInsert = vi.fn(() => chainable({ data: { id: 't1', created_at: 'now' }, error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return { select: () => chainable({ count: 0, error: null }), insert: ticketInsert } as any
      if (table === 'support_messages') return { insert: vi.fn(() => chainable({ error: null })) } as any
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: 'help' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ticket: { id: 't1', status: 'open', createdAt: 'now' } })
  })

  it('rejects an empty ticket body', async () => {
    mockAuthUserLookup()
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_body' })
  })

  it('returns 429 when the open-ticket limit is hit', async () => {
    mockAuthUserLookup()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return { select: () => chainable({ count: 5, error: null }) } as any
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: 'help' } })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'too_many_open_tickets' })
  })

  it('404s a foreign ticket on reply', async () => {
    mockAuthUserLookup()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return { select: () => chainable({ data: null, error: null }) } as any
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'POST', url: '/support/tickets/t9/messages', headers: AUTH, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(404)
  })

  it('lists tickets with preview + unread', async () => {
    mockAuthUserLookup()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return {
          select: () => chainable({
            data: [{ id: 't1', status: 'open', last_sender: 'admin', last_message_at: 'now', created_at: 'then' }],
            error: null,
          }),
        } as any
      }
      if (table === 'support_messages') {
        return {
          select: () => chainable({
            data: [{ ticket_id: 't1', body: 'help me', created_at: 'then' }],
            error: null,
          }),
        } as any
      }
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'GET', url: '/support/tickets', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tickets[0]).toMatchObject({ id: 't1', status: 'open', preview: 'help me', unread: true })
  })

  it('404s a foreign ticket on detail fetch', async () => {
    mockAuthUserLookup()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return { select: () => chainable({ data: null, error: null }) } as any
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'GET', url: '/support/tickets/t9', headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('returns ticket detail and stamps admin messages read', async () => {
    mockAuthUserLookup()
    const updateSpy = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return { select: () => chainable({ data: { id: 't1', status: 'open', created_at: 'then' }, error: null }) } as any
      }
      if (table === 'support_messages') {
        return {
          select: () => chainable({ data: [{ id: 'm1', sender: 'admin', body: 'hi', created_at: 'now' }], error: null }),
          update: updateSpy,
        } as any
      }
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'GET', url: '/support/tickets/t1', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.messages[0].sender).toBe('admin')
    expect(updateSpy).toHaveBeenCalled()
  })

  it('sends a reply and reopens the ticket', async () => {
    mockAuthUserLookup()
    const ticketUpdate = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return { select: () => chainable({ data: { id: 't1' }, error: null }), update: ticketUpdate } as any
      }
      if (table === 'support_messages') {
        return { insert: () => chainable({ data: { id: 'm2', sender: 'user', body: 'hi', created_at: 'now' }, error: null }) } as any
      }
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'POST', url: '/support/tickets/t1/messages', headers: AUTH, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.message).toMatchObject({ id: 'm2', sender: 'user', body: 'hi' })
    expect(ticketUpdate.mock.calls[0][0]).toMatchObject({ status: 'open', last_sender: 'user' })
  })
})
