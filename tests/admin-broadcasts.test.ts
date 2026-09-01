import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ sendBroadcastMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/messaging/broadcast.js', async (orig) => ({
  ...(await orig<typeof import('../src/messaging/broadcast.js')>()),
  runBroadcast: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

function mockTables(results: Record<string, unknown>) {
  vi.mocked(db.from).mockImplementation((table: string) => chainable(results[table]))
}

const BROADCAST_ROW = {
  id: 'b1', message: 'hello', filters: {}, status: 'running',
  total_recipients: 3, sent_count: 0, failed_count: 0,
  created_at: '2026-09-01T00:00:00Z', finished_at: null, error: null,
  created_by_username: 'root',
}

describe('admin broadcasts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('POST /admin/broadcasts/preview returns the audience count', async () => {
    mockTables({ users: { count: 42, error: null } })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: { filters: { genders: ['female'] } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 42 })
  })

  it('POST /admin/broadcasts rejects an empty message', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: '   ', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
  })

  it('POST /admin/broadcasts rejects a message over 4096 chars', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'x'.repeat(4097), filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('message_too_long')
  })

  it('POST /admin/broadcasts rejects an empty audience', async () => {
    // fetchAudience -> users select returns [] (no matches)
    mockTables({ users: { data: [], error: null } })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_audience')
  })

  it('POST /admin/broadcasts creates a job row and returns it', async () => {
    // users -> audience fetch (2 targets); broadcasts -> insert().select().single() row
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'u0', telegram_id: 1 }, { id: 'u1', telegram_id: 2 }], error: null })
      if (table === 'broadcasts') return chainable({ data: BROADCAST_ROW, error: null })
      return chainable(null)
    })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hello', filters: {} } })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast.id).toBe('b1')
    expect(res.json().broadcast.totalRecipients).toBe(3)
  })

  it('GET /admin/broadcasts lists jobs', async () => {
    mockTables({ broadcasts: { data: [BROADCAST_ROW], error: null } })
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(1)
    expect(res.json().items[0].createdByUsername).toBe('root')
  })

  it('GET /admin/broadcasts/:id returns one job', async () => {
    mockTables({ broadcasts: { data: BROADCAST_ROW, error: null } })
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts/b1', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast.status).toBe('running')
  })

  it('POST /admin/broadcasts rejects an invalid button', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {}, button: { title: 'Go', kind: 'url', url: 'bad' } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('button_url_invalid')
  })

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts' })
    expect(res.statusCode).toBe(401)
  })
})
