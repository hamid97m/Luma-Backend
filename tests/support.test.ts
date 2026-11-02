import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { failOn, clearFailures } from './helpers/bot-support.js'

describe('support routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let other: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ name: 'Ali' })
    other = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
    authAs(me)
  })
  afterEach(clearFailures)

  const ticket = (user_id: string, extra: Record<string, unknown> = {}) =>
    insertRow('support_tickets', { user_id, ...extra })
  const msg = (ticket_id: string, sender: 'user' | 'admin', body: string, extra: Record<string, unknown> = {}) =>
    insertRow('support_messages', { ticket_id, sender, body, ...extra })

  it('creates a ticket', async () => {
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: 'help' } })
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select id, created_at from support_tickets where user_id = ${me.id}`
    expect(res.json()).toEqual({ ticket: { id: row.id, status: 'open', createdAt: row.created_at } })
  })

  it('rejects an empty ticket body', async () => {
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_body' })
  })

  it('returns 429 when the open-ticket limit is hit', async () => {
    for (let i = 0; i < 5; i++) await ticket(me.id)
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: 'help' } })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'too_many_open_tickets' })
  })

  it('500 create_failed when the insert fails', async () => {
    await failOn('support_tickets', 'insert')
    const res = await app.inject({ method: 'POST', url: '/support/tickets', headers: AUTH, payload: { body: 'help' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'create_failed' })
  })

  it('404s a foreign ticket on reply', async () => {
    const t = await ticket(other.id)
    const res = await app.inject({ method: 'POST', url: `/support/tickets/${t.id}/messages`, headers: AUTH, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(404)
    expect(await sql`select id from support_messages`).toHaveLength(0)
  })

  it('404s (not 500) a malformed ticket id on reply and detail', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/support/tickets/t9/messages', headers: AUTH, payload: { body: 'hi' } })
    expect(r1.statusCode).toBe(404)
    const r2 = await app.inject({ method: 'GET', url: '/support/tickets/t9', headers: AUTH })
    expect(r2.statusCode).toBe(404)
    expect(r2.json()).toEqual({ error: 'ticket_not_found' })
  })

  it('lists only my tickets, newest activity first, with preview + unread', async () => {
    const older = await ticket(me.id, { last_message_at: '2026-01-01T00:00:00.000Z', last_sender: 'user' })
    const newer = await ticket(me.id, { last_message_at: '2026-02-01T00:00:00.000Z', last_sender: 'admin' })
    await ticket(other.id)
    await msg(newer.id, 'user', 'help me', { created_at: '2026-01-31T00:00:00.000Z' })
    await msg(newer.id, 'admin', 'on it', { created_at: '2026-02-01T00:00:00.000Z' })
    await msg(older.id, 'user', 'x'.repeat(200))
    await msg(older.id, 'admin', 'read already', { read_by_user_at: new Date().toISOString() })

    const res = await app.inject({ method: 'GET', url: '/support/tickets', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { tickets } = res.json()
    expect(tickets.map((t: any) => t.id)).toEqual([newer.id, older.id])
    expect(tickets[0]).toMatchObject({
      id: newer.id, status: 'open', lastSender: 'admin', preview: 'help me', unread: true,
      lastMessageAt: '2026-02-01T00:00:00.000Z',
    })
    expect(tickets[1]).toMatchObject({ unread: false, preview: 'x'.repeat(120) })
  })

  it('lists an empty array when I have no tickets', async () => {
    const res = await app.inject({ method: 'GET', url: '/support/tickets', headers: AUTH })
    expect(res.json()).toEqual({ tickets: [] })
  })

  it('404s a foreign ticket on detail fetch', async () => {
    const t = await ticket(other.id)
    const res = await app.inject({ method: 'GET', url: `/support/tickets/${t.id}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('returns ticket detail and stamps admin messages read', async () => {
    const t = await ticket(me.id)
    await msg(t.id, 'user', 'help', { created_at: '2026-01-01T00:00:00.000Z' })
    await msg(t.id, 'admin', 'hi', { created_at: '2026-01-02T00:00:00.000Z' })

    const res = await app.inject({ method: 'GET', url: `/support/tickets/${t.id}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ticket).toEqual({ id: t.id, status: 'open', createdAt: t.created_at })
    expect(body.messages.map((m: any) => m.sender)).toEqual(['user', 'admin'])
    expect(body.messages[1]).toMatchObject({ body: 'hi', createdAt: '2026-01-02T00:00:00.000Z' })

    const rows = await sql`select sender, read_by_user_at from support_messages order by created_at`
    expect(rows[0].read_by_user_at).toBeNull() // user's own message untouched
    expect(rows[1].read_by_user_at).not.toBeNull()
  })

  it('sends a reply and reopens the ticket', async () => {
    const t = await ticket(me.id, { status: 'closed', last_sender: 'admin' })
    const res = await app.inject({ method: 'POST', url: `/support/tickets/${t.id}/messages`, headers: AUTH, payload: { body: ' hi ' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.message).toMatchObject({ sender: 'user', body: 'hi' })
    const [row] = await sql`select status, last_sender from support_tickets where id = ${t.id}`
    expect(row).toEqual({ status: 'open', last_sender: 'user' })
  })

  it('500 send_failed when the message insert fails', async () => {
    const t = await ticket(me.id)
    await failOn('support_messages', 'insert')
    const res = await app.inject({ method: 'POST', url: `/support/tickets/${t.id}/messages`, headers: AUTH, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'send_failed' })
  })

  it('500s when the ticket reopen update fails after a successful reply', async () => {
    const t = await ticket(me.id)
    await failOn('support_tickets', 'update')
    const res = await app.inject({ method: 'POST', url: `/support/tickets/${t.id}/messages`, headers: AUTH, payload: { body: 'hi' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'reopen_failed' })
  })
})
