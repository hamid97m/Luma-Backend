import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, premiumGateBlocks: vi.fn() }
})

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { premiumGateBlocks } from '../src/premium/service.js'
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

describe('premium gate on message send', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('403s with premium_required when the gate blocks', async () => {
    auth()
    mockSendDb('woman')
    vi.mocked(premiumGateBlocks).mockResolvedValue(true)
    const res = await app.inject({
      method: 'POST', url: '/matches/m1/messages', headers: { authorization: 'x' }, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'premium_required' })
    expect(premiumGateBlocks).toHaveBeenCalledWith('u1', 'woman')
  })

  it('sends normally when the gate does not block', async () => {
    auth()
    mockSendDb('woman')
    vi.mocked(premiumGateBlocks).mockResolvedValue(false)
    const res = await app.inject({
      method: 'POST', url: '/matches/m1/messages', headers: { authorization: 'x' }, payload: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().message.id).toBe('msg1')
  })
})

describe('premiumGateBlocks (unmocked)', () => {
  beforeEach(() => vi.clearAllMocks())

  async function realGate() {
    const real = await vi.importActual<typeof import('../src/premium/service.js')>('../src/premium/service.js')
    return real.premiumGateBlocks
  }

  it('never blocks when the partner is not a woman — and never touches the db', async () => {
    const gate = await realGate()
    expect(await gate('u1', 'man')).toBe(false)
    expect(await gate('u1', null)).toBe(false)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('never blocks when premium is disabled', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: false } })
      return chainable({ data: null })
    })
    const gate = await realGate()
    expect(await gate('u1', 'woman')).toBe(false)
  })

  it('blocks a non-premium sender messaging a woman', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null } })
      return chainable({ data: null })
    })
    const gate = await realGate()
    expect(await gate('u1', 'woman')).toBe(true)
  })

  it('does not block an active-premium sender', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: new Date(Date.now() + 86400000).toISOString() } })
      return chainable({ data: null })
    })
    const gate = await realGate()
    expect(await gate('u1', 'woman')).toBe(false)
  })
})
