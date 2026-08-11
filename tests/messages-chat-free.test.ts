import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

function auth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
}

/** Table-keyed db mock covering auth (users), getUsableMatch (matches), and insert (messages). */
function mockSendDb(partnerGender: string | null) {
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return chainable({ data: { id: 'u1' } })
    if (table === 'matches') {
      return chainable({ data: {
        id: 'm1', user1_id: 'u1', user2_id: 'u2',
        user1: { id: 'u1', name: 'Me', telegram_id: 1, deleted_at: null, last_active: new Date().toISOString(), notified_offline_at: null, allows_write_to_pm: true },
        user2: { id: 'u2', name: 'Sara', telegram_id: 2, deleted_at: null, last_active: new Date().toISOString(), notified_offline_at: null, allows_write_to_pm: true, gender: partnerGender },
      } })
    }
    if (table === 'messages') {
      return chainable({ data: { id: 'msg1', sender_id: 'u1', body: 'hi', created_at: '2026-08-05T00:00:00Z', reply_to_message_id: null }, error: null })
    }
    return chainable({ data: null })
  })
}

describe('chat is free for everyone (no premium gate on send)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  async function send(partnerGender: string | null) {
    auth()
    mockSendDb(partnerGender)
    return app.inject({
      method: 'POST', url: '/matches/m1/messages', headers: { authorization: 'x' }, payload: { body: 'hi' },
    })
  }

  it('a free user can message a woman', async () => {
    const res = await send('woman')
    expect(res.statusCode).toBe(200)
    expect(res.json().message.id).toBe('msg1')
  })

  it('a free user can message a man', async () => {
    const res = await send('man')
    expect(res.statusCode).toBe(200)
    expect(res.json().message.id).toBe('msg1')
  })

  it('never reads premium_config on send — messaging does not consult premium at all', async () => {
    await send('woman')
    const tablesTouched = vi.mocked(db.from).mock.calls.map((c) => c[0])
    expect(tablesTouched).not.toContain('premium_config')
  })
})
