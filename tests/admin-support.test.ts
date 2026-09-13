import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyTicketReply: vi.fn(() => Promise.resolve()) }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { notifyTicketReply } from '../src/bot.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin support', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('lists open tickets with a needsReply flag', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return chainable({
          data: [{
            id: 't1', status: 'open', last_sender: 'user', last_message_at: 'now', created_at: 'then',
            user: { id: 'u1', name: 'Sara', user_photos: [{ url: 'p.jpg', position: 0 }] },
          }],
          count: 1, error: null,
        })
      }
      if (table === 'support_messages') {
        return chainable({ data: [{ ticket_id: 't1', body: 'help me', created_at: 'then' }], error: null })
      }
      return chainable({ data: [], error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/support/tickets?status=open', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ id: 't1', needsReply: true, user: { id: 'u1', name: 'Sara' } })
  })

  it('replies, stamps admin_id, flips last_sender, and notifies', async () => {
    const msgInsert = vi.fn(() => chainable({ data: { id: 'm1', sender: 'admin', body: 'hi', created_at: 'now' }, error: null }))
    const ticketUpdate = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') {
        return {
          select: () => chainable({
            data: { id: 't1', user: { telegram_id: 555, allows_write_to_pm: true } }, error: null,
          }),
          update: ticketUpdate,
        } as any
      }
      if (table === 'support_messages') {
        return {
          insert: msgInsert,
          // Only the preview select uses the table-level `select`; the insert
          // path resolves through msgInsert's own `.select().single()` chain.
          select: () => chainable({ data: { body: 'help me' }, error: null }),
        } as any
      }
      return chainable({ error: null })
    })

    const res = await app.inject({
      method: 'POST', url: '/admin/support/tickets/t1/reply', headers, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect((msgInsert.mock.calls[0][0] as any)).toMatchObject({ ticket_id: 't1', sender: 'admin', admin_id: 'a1', body: 'hi' })
    expect((ticketUpdate.mock.calls[0][0] as any)).toMatchObject({ last_sender: 'admin', status: 'open' })
    expect(notifyTicketReply).toHaveBeenCalledWith(555, 'help me', 'hi')
  })

  it('rejects an empty reply', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/support/tickets/t1/reply', headers, payload: { body: '  ' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_body' })
  })

  it('closes a ticket', async () => {
    const ticketUpdate = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'support_tickets') return { update: ticketUpdate } as any
      return chainable({ error: null })
    })
    const res = await app.inject({ method: 'POST', url: '/admin/support/tickets/t1/close', headers })
    expect(res.statusCode).toBe(200)
    expect((ticketUpdate.mock.calls[0][0] as any)).toMatchObject({ status: 'closed', closed_by: 'a1' })
  })
})
