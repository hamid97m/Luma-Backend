import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyTicketReply: vi.fn(() => Promise.resolve()) }))

import { buildApp } from '../src/server.js'
import { notifyTicketReply } from '../src/bot.js'
import { resetDb, createUser, createPhoto, insertRow, sql } from './helpers/db.js'
import { createAdmin } from './helpers/admin.js'
import { failOn, clearFailures } from './helpers/bot-support.js'

describe('admin support', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let admin: { id: string }
  let sara: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    ;({ admin, headers } = await createAdmin())
    sara = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', telegram_id: 555, locale: 'en' })
  })
  afterEach(clearFailures)

  const ticket = (extra: Record<string, unknown> = {}) => insertRow('support_tickets', { user_id: sara.id, ...extra })
  const msg = (ticket_id: string, sender: 'user' | 'admin', body: string, created_at: string) =>
    insertRow('support_messages', { ticket_id, sender, body, created_at })

  it('lists open tickets with a needsReply flag, user, photo and preview', async () => {
    await createPhoto(sara.id, 1, { url: 'p1.jpg' })
    await createPhoto(sara.id, 0, { url: 'p0.jpg' })
    const t = await ticket({ last_sender: 'user' })
    await ticket({ status: 'closed' })
    await msg(t.id, 'user', 'help me', '2026-01-01T00:00:00.000Z')
    await msg(t.id, 'admin', 'later', '2026-01-02T00:00:00.000Z')

    const res = await app.inject({ method: 'GET', url: '/admin/support/tickets?status=open', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ total: 1, page: 1, pageCount: 1 })
    expect(body.items).toEqual([{
      id: t.id, user: { id: sara.id, name: 'Sara', photo: 'p0.jpg' }, status: 'open', lastSender: 'user',
      lastMessageAt: t.last_message_at, createdAt: t.created_at, preview: 'help me', needsReply: true,
    }])
  })

  it('orders needs-reply (user) tickets first, then newest activity; filters by status', async () => {
    const adminOld = await ticket({ last_sender: 'admin', last_message_at: '2026-01-01T00:00:00.000Z' })
    const adminNew = await ticket({ last_sender: 'admin', last_message_at: '2026-03-01T00:00:00.000Z' })
    const userOld = await ticket({ last_sender: 'user', last_message_at: '2026-02-01T00:00:00.000Z' })
    const closed = await ticket({ status: 'closed', last_sender: 'user' })

    const all = (await app.inject({ method: 'GET', url: '/admin/support/tickets?status=all', headers })).json()
    expect(all.items.map((i: any) => i.id)).toEqual([closed.id, userOld.id, adminNew.id, adminOld.id])
    expect(all.total).toBe(4)

    const needs = (await app.inject({ method: 'GET', url: '/admin/support/tickets?status=needs_reply', headers })).json()
    expect(needs.items.map((i: any) => i.id)).toEqual([userOld.id])

    const closedRes = (await app.inject({ method: 'GET', url: '/admin/support/tickets?status=closed', headers })).json()
    expect(closedRes.items.map((i: any) => i.id)).toEqual([closed.id])
    expect(closedRes.items[0]).toMatchObject({ user: { photo: null }, preview: '' })
  })

  it('paginates 20 per page with an exact total', async () => {
    for (let i = 0; i < 21; i++) await ticket()
    const p2 = (await app.inject({ method: 'GET', url: '/admin/support/tickets?page=2', headers })).json()
    expect(p2).toMatchObject({ total: 21, page: 2, pageCount: 2 })
    expect(p2.items).toHaveLength(1)
  })

  it('returns a ticket with its thread', async () => {
    const t = await ticket()
    await msg(t.id, 'admin', 'second', '2026-01-02T00:00:00.000Z')
    await msg(t.id, 'user', 'first', '2026-01-01T00:00:00.000Z')
    const res = await app.inject({ method: 'GET', url: `/admin/support/tickets/${t.id}`, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ticket).toEqual({
      id: t.id, status: 'open', createdAt: t.created_at, closedAt: null,
      user: { id: sara.id, name: 'Sara', photo: null, telegramId: 555 },
    })
    expect(body.messages.map((m: any) => m.body)).toEqual(['first', 'second'])
  })

  it('404s an unknown or malformed ticket id', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/admin/support/tickets/00000000-0000-0000-0000-000000000000', headers })
    expect(r1.statusCode).toBe(404)
    const r2 = await app.inject({ method: 'GET', url: '/admin/support/tickets/t1', headers })
    expect(r2.statusCode).toBe(404)
    const r3 = await app.inject({ method: 'POST', url: '/admin/support/tickets/t1/reply', headers, payload: { body: 'hi' } })
    expect(r3.statusCode).toBe(404)
    expect(r3.json()).toEqual({ error: 'ticket_not_found' })
  })

  it('replies, stamps admin_id, flips last_sender, and notifies', async () => {
    const t = await ticket({ status: 'closed', last_sender: 'user' })
    await msg(t.id, 'user', 'help me', '2026-01-01T00:00:00.000Z')

    const res = await app.inject({
      method: 'POST', url: `/admin/support/tickets/${t.id}/reply`, headers, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().message).toMatchObject({ sender: 'admin', body: 'hi' })
    const [m] = await sql`select ticket_id, sender, admin_id, body from support_messages where sender = 'admin'`
    expect(m).toEqual({ ticket_id: t.id, sender: 'admin', admin_id: admin.id, body: 'hi' })
    const [row] = await sql`select status, last_sender from support_tickets where id = ${t.id}`
    expect(row).toEqual({ status: 'open', last_sender: 'admin' })
    expect(notifyTicketReply).toHaveBeenCalledWith(555, 'help me', 'hi', 'en')
  })

  it('does not notify a user who disabled bot DMs', async () => {
    await sql`update users set allows_write_to_pm = false where id = ${sara.id}`
    const t = await ticket()
    const res = await app.inject({ method: 'POST', url: `/admin/support/tickets/${t.id}/reply`, headers, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(notifyTicketReply).not.toHaveBeenCalled()
  })

  it('500 reply_failed when the message insert fails', async () => {
    const t = await ticket()
    await failOn('support_messages', 'insert')
    const res = await app.inject({ method: 'POST', url: `/admin/support/tickets/${t.id}/reply`, headers, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'reply_failed' })
  })

  it('rejects an empty reply', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/support/tickets/t1/reply', headers, payload: { body: '  ' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_body' })
  })

  it('closes and reopens a ticket', async () => {
    const t = await ticket()
    const res = await app.inject({ method: 'POST', url: `/admin/support/tickets/${t.id}/close`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const [closed] = await sql`select status, closed_by, closed_at from support_tickets where id = ${t.id}`
    expect(closed).toMatchObject({ status: 'closed', closed_by: admin.id })
    expect(closed.closed_at).not.toBeNull()

    const re = await app.inject({ method: 'POST', url: `/admin/support/tickets/${t.id}/reopen`, headers })
    expect(re.json()).toEqual({ ok: true })
    const [open] = await sql`select status, closed_by, closed_at from support_tickets where id = ${t.id}`
    expect(open).toEqual({ status: 'open', closed_by: null, closed_at: null })
  })

  it('close/reopen of a malformed id is a no-op ok (no rows matched)', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/support/tickets/t1/close', headers })).json()).toEqual({ ok: true })
    expect((await app.inject({ method: 'POST', url: '/admin/support/tickets/t1/reopen', headers })).json()).toEqual({ ok: true })
  })

  it('500 close_failed when the update fails', async () => {
    const t = await ticket()
    await failOn('support_tickets', 'update')
    const res = await app.inject({ method: 'POST', url: `/admin/support/tickets/${t.id}/close`, headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'close_failed' })
  })
})
