import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
// premium_config belongs to the premium area; pin the toggle here.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { buildApp } from '../src/server.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow } from './helpers/db.js'

describe('GET /matches premiumRequired', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { await resetDb(); app = await buildApp() })

  async function setup(opts: { enabled: boolean; myPremiumUntil: string | null; partnerGender: string }) {
    vi.mocked(isPremiumEnabled).mockResolvedValue(opts.enabled)
    const me = await createUser({ name: 'Me', gender: 'man', looking_for: 'women', premium_until: opts.myPremiumUntil })
    const partner = await createUser({ name: 'Sara', gender: opts.partnerGender, looking_for: 'men' })
    await createMatch(me.id, partner.id)
    authAs(me)
    return me
  }

  async function fetchMatches() {
    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })
    expect(res.statusCode).toBe(200)
    return res.json().matches
  }

  it('false for a first chat — even when premium is enabled, partner is a woman, and I am not premium', async () => {
    await setup({ enabled: true, myPremiumUntil: null, partnerGender: 'woman' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('false when premium is disabled', async () => {
    await setup({ enabled: false, myPremiumUntil: null, partnerGender: 'woman' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('false when the partner is a man', async () => {
    await setup({ enabled: true, myPremiumUntil: null, partnerGender: 'man' })
    expect((await fetchMatches())[0].premiumRequired).toBe(false)
  })

  it('never leaks the partner gender in the payload', async () => {
    await setup({ enabled: true, myPremiumUntil: null, partnerGender: 'woman' })
    expect((await fetchMatches())[0].user.gender).toBeUndefined()
  })

  it('locks only new chats once a gated free man has used his free chats (icebreakers do not count)', async () => {
    const me = await setup({ enabled: true, myPremiumUntil: null, partnerGender: 'woman' })
    const [fresh] = await fetchMatches()
    const chatted: string[] = []
    for (const name of ['A', 'B']) {
      const p = await createUser({ name, gender: 'woman', looking_for: 'men' })
      const m = await createMatch(me.id, p.id)
      await insertRow('messages', { match_id: m.id, sender_id: me.id, body: 'hi' })
      await insertRow('messages', { match_id: m.id, sender_id: me.id, body: 'again' })
      chatted.push(m.id)
    }
    // An auto-posted icebreaker in the fresh match does not make it "chatted".
    await insertRow('messages', { match_id: fresh.id, sender_id: me.id, body: 'Q?', type: 'icebreaker' })

    const flags = Object.fromEntries((await fetchMatches()).map((m: any) => [m.id, m.premiumRequired]))
    expect(flags).toEqual({ [fresh.id]: true, [chatted[0]]: false, [chatted[1]]: false })
  })

  it('a premium-active man is never locked', async () => {
    const me = await setup({ enabled: true, myPremiumUntil: '2099-01-01T00:00:00Z', partnerGender: 'woman' })
    for (const name of ['A', 'B']) {
      const p = await createUser({ name })
      const m = await createMatch(me.id, p.id)
      await insertRow('messages', { match_id: m.id, sender_id: me.id, body: 'hi' })
    }
    expect((await fetchMatches()).every((m: any) => m.premiumRequired === false)).toBe(true)
  })
})
