import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({
  notifyPaused: vi.fn(() => Promise.resolve()),
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
  forwardBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { buildApp } from '../src/server.js'
import { sendBroadcastMessage, forwardBroadcastMessage } from '../src/bot.js'
import { resetDb, createUser } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

let userId = ''
/** The target user for /admin/users/:id/message. */
async function mockUser(row: { telegram_id: number; is_seed: boolean }) {
  userId = (await createUser(row)).id
}
const url = () => `/admin/users/${userId}/message`

describe('admin user message (single-user bot DM)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    userId = '00000000-0000-0000-0000-000000000000'
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  it('sends a bot DM to the user and returns ok', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hello there' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(sendBroadcastMessage).toHaveBeenCalledWith(555, 'hello there', undefined)
  })

  it('rejects an empty message', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('rejects a message over 4096 chars', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'x'.repeat(4097) } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('message_too_long')
  })

  it('404s when the user does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('user_not_found')
  })

  it('404s (not 500) for a malformed id', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/message', headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('user_not_found')
  })

  it('500 user_fetch_failed when the lookup fails', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const res = await withTableBroken('users', () =>
      app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } }))
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('user_fetch_failed')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('400 not_messageable for a seed user', async () => {
    await mockUser({ telegram_id: 555, is_seed: true })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('not_messageable')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('400 not_messageable for a non-positive telegram_id', async () => {
    await mockUser({ telegram_id: -7, is_seed: false })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('not_messageable')
  })

  it('surfaces user_blocked_bot on a Telegram 403 (no opt-out change)', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    vi.mocked(sendBroadcastMessage).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { error_code: 403 }))
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('user_blocked_bot')
  })

  it('502 send_failed on other bot errors', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    vi.mocked(sendBroadcastMessage).mockRejectedValueOnce(new Error('network'))
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('send_failed')
  })

  it('passes a valid screen button through to the bot', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const button = { title: 'See likes', kind: 'screen', screen: 'likes' }
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi', button } })
    expect(res.statusCode).toBe(200)
    expect(sendBroadcastMessage).toHaveBeenCalledWith(555, 'hi', { title: 'See likes', kind: 'screen', screen: 'likes' })
  })

  it('sends with no button when none is provided (undefined third arg)', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(sendBroadcastMessage).toHaveBeenCalledWith(555, 'hi', undefined)
  })

  it('rejects an invalid button (400) before sending', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { text: 'hi', button: { title: 'Go', kind: 'url', url: 'not-a-url' } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('button_url_invalid')
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('forwards a channel message to the user', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(forwardBroadcastMessage).toHaveBeenCalledWith(555, '@mychannel', 123)
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('rejects an invalid forward link (400) before any lookup', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { kind: 'forward', link: 'not a link' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_link')
    expect(forwardBroadcastMessage).not.toHaveBeenCalled()
  })

  it('surfaces user_blocked_bot when a forward hits a Telegram 403', async () => {
    await mockUser({ telegram_id: 555, is_seed: false })
    vi.mocked(forwardBroadcastMessage).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { error_code: 403 }))
    const res = await app.inject({ method: 'POST', url: url(), headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('user_blocked_bot')
  })

  it('requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: url(), payload: { text: 'hi' } })
    expect(res.statusCode).toBe(401)
  })
})
