import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({
  notifyPaused: vi.fn(() => Promise.resolve()),
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { sendBroadcastMessage } from '../src/bot.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

function mockUser(row: unknown, error: unknown = null) {
  vi.mocked(db.from).mockImplementation((table: string) =>
    (table === 'users' ? chainable({ data: row, error }) : chainable({ data: null, error: null })))
}

describe('admin user message (single-user bot DM)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('sends a bot DM to the user and returns ok', async () => {
    mockUser({ telegram_id: 555, is_seed: false })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'hello there' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(sendBroadcastMessage).toHaveBeenCalledWith(555, 'hello there')
  })

  it('rejects an empty message', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('rejects a message over 4096 chars', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'x'.repeat(4097) } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('message_too_long')
  })

  it('404s when the user does not exist', async () => {
    mockUser(null, { code: 'PGRST116', message: 'no rows' })
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('user_not_found')
  })

  it('400 not_messageable for a seed user', async () => {
    mockUser({ telegram_id: 555, is_seed: true })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('not_messageable')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('400 not_messageable for a non-positive telegram_id', async () => {
    mockUser({ telegram_id: -7, is_seed: false })
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('not_messageable')
  })

  it('surfaces user_blocked_bot on a Telegram 403 (no opt-out change)', async () => {
    mockUser({ telegram_id: 555, is_seed: false })
    vi.mocked(sendBroadcastMessage).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { error_code: 403 }))
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('user_blocked_bot')
  })

  it('502 send_failed on other bot errors', async () => {
    mockUser({ telegram_id: 555, is_seed: false })
    vi.mocked(sendBroadcastMessage).mockRejectedValueOnce(new Error('network'))
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('send_failed')
  })

  it('requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/message', payload: { text: 'hi' } })
    expect(res.statusCode).toBe(401)
  })
})
