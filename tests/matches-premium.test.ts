import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

function matchRow(partnerGender: string) {
  return {
    id: 'm1', created_at: '2026-08-01T00:00:00Z', user1_id: 'u1', user2_id: 'u2',
    user1: { id: 'u1', name: 'Me', telegram_id: 1, username: null, deleted_at: null, age: 30, bio: null, icebreaker_prompt: null, icebreaker_answer: null, gender: 'man' },
    user2: { id: 'u2', name: 'Sara', telegram_id: 2, username: null, deleted_at: null, age: 28, bio: null, icebreaker_prompt: null, icebreaker_answer: null, gender: partnerGender },
  }
}

function mockDb(opts: { enabled: boolean; myPremiumUntil: string | null; partnerGender: string }) {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return chainable({ data: { id: 'u1', premium_until: opts.myPremiumUntil } })
    if (table === 'premium_config') return chainable({ data: { premium_enabled: opts.enabled } })
    if (table === 'blocks') return chainable({ data: [] })
    if (table === 'matches') return chainable({ data: [matchRow(opts.partnerGender)] })
    if (table === 'user_photos') return chainable({ data: [] })
    if (table === 'messages') return chainable({ data: [], count: 0 })
    return chainable({ data: null })
  })
}

describe('GET /matches premiumRequired', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  async function fetchMatches() {
    const res = await app.inject({ method: 'GET', url: '/matches', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(200)
    return res.json().matches
  }

  it('true when enabled, partner is a woman, and I am not premium', async () => {
    mockDb({ enabled: true, myPremiumUntil: null, partnerGender: 'woman' })
    const matches = await fetchMatches()
    expect(matches[0].premiumRequired).toBe(true)
  })

  it('false when premium is disabled', async () => {
    mockDb({ enabled: false, myPremiumUntil: null, partnerGender: 'woman' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('false when the partner is a man', async () => {
    mockDb({ enabled: true, myPremiumUntil: null, partnerGender: 'man' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('false when I have active premium', async () => {
    mockDb({ enabled: true, myPremiumUntil: new Date(Date.now() + 86400000).toISOString(), partnerGender: 'woman' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('never leaks the partner gender in the payload', async () => {
    mockDb({ enabled: true, myPremiumUntil: null, partnerGender: 'woman' })
    expect((await fetchMatches())[0].user.gender).toBeUndefined()
  })
})
