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
})
