import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  sendBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  forwardBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  verifyForwardSource: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/messaging/broadcast.js', async (orig) => ({
  ...(await orig<typeof import('../src/messaging/broadcast.js')>()),
  runBroadcast: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { verifyForwardSource } from '../src/bot.js'
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

  it('POST /admin/broadcasts (forward) rejects an invalid link', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'not a link', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_link')
  })

  it('POST /admin/broadcasts (forward) 400s when the source is unreachable', async () => {
    vi.mocked(verifyForwardSource).mockRejectedValueOnce(
      Object.assign(new Error('Bad Request: message to forward not found'), { description: 'Bad Request: message to forward not found' }),
    )
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('forward_source_unreachable')
  })

  it('POST /admin/broadcasts (forward) creates a forward job row', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: [{ id: 'u0', telegram_id: 1 }, { id: 'u1', telegram_id: 2 }], error: null })
      if (table === 'broadcasts') return chainable({ data: { ...BROADCAST_ROW, kind: 'forward', message: 'https://t.me/mychannel/123' }, error: null })
      return chainable(null)
    })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123', filters: {} } })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast.kind).toBe('forward')
    expect(verifyForwardSource).toHaveBeenCalledWith('@mychannel', 123)
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

  // --- Abandoned-checkout auto-message config ---

  const PURCHASE_CFG_ROW = {
    enabled: true, kind: 'text', message: 'come back', button: null,
    source_chat_id: null, source_message_id: null, active_since: '2026-09-09T00:00:00Z',
  }
  function mockPurchaseTables() {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'purchase_message_config') return chainable({ data: PURCHASE_CFG_ROW, error: null })
      if (table === 'purchase_message_sends') return chainable({ count: 5, error: null })
      return chainable(null)
    })
  }

  it('GET /admin/broadcasts/purchase-message returns config + sent count', async () => {
    mockPurchaseTables()
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts/purchase-message', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.enabled).toBe(true)
    expect(res.json().config.sentCount).toBe(5)
  })

  it('PUT /admin/broadcasts/purchase-message saves a text message', async () => {
    mockPurchaseTables()
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'text', message: 'come back' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.kind).toBe('text')
  })

  it('PUT purchase-message saves translations (text) and clears them (forward)', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'purchase_message_config') {
        return {
          select: () => chainable({ data: PURCHASE_CFG_ROW, error: null }),
          update: (p: any) => { updates.push(p); return chainable({ data: { ...PURCHASE_CFG_ROW, ...p }, error: null }) },
        } as any
      }
      if (table === 'purchase_message_sends') return chainable({ count: 5, error: null })
      return chainable(null)
    })
    const translations = { en: { message: 'Come back!', buttonTitle: 'Plans' } }
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: true, kind: 'text', message: 'come back', translations } })
    expect(res.statusCode).toBe(200)
    expect(updates[0].translations).toEqual(translations)
    expect(res.json().config.translations).toEqual(translations)

    const fwd = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: false, kind: 'forward', link: 'https://t.me/mychannel/9' } })
    expect(fwd.statusCode).toBe(200)
    expect(updates[1].translations).toEqual({})
  })

  it('PUT purchase-message rejects malformed translations', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: true, kind: 'text', message: 'come back', translations: { de: { message: 'x' } } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_translations')
  })

  it('PUT purchase-message rejects an empty message when enabled', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'text', message: '  ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
  })

  it('PUT purchase-message rejects an invalid forward link', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'forward', link: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_link')
  })

  it('PUT purchase-message 400s when the forward source is unreachable', async () => {
    vi.mocked(verifyForwardSource).mockRejectedValueOnce(
      Object.assign(new Error('Bad Request: chat not found'), { description: 'Bad Request: chat not found' }),
    )
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'forward', link: 'https://t.me/mychannel/9' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('forward_source_unreachable')
  })
})
