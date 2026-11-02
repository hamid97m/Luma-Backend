import { describe, it, expect, vi, beforeEach } from 'vitest'

// premium_config belongs to the premium area; pin the toggle per test.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { isPremiumEnabled } from '../src/premium/service.js'
import {
  FREE_CHAT_LIMIT, chatLimitApplies, matchPremiumRequired, chatGateContext, chatSendBlocked,
} from '../src/premium/chatLimit.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

const NOW = new Date('2026-08-31T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('chatLimitApplies (shared swipe cohort)', () => {
  it('applies to men and women whose preference includes women', () => {
    expect(chatLimitApplies('man', 'women')).toBe(true)
    expect(chatLimitApplies('man', 'both')).toBe(true)
    expect(chatLimitApplies('woman', 'women')).toBe(true)
    expect(chatLimitApplies('woman', 'both')).toBe(true)
    expect(chatLimitApplies('woman', 'men')).toBe(false)
    expect(chatLimitApplies('man', 'men')).toBe(false)
  })
})

describe('matchPremiumRequired (pure decision)', () => {
  const ctx = (gated: boolean, ids: string[]) => ({ gated, chattedMatchIds: new Set(ids) })

  it('never blocks a non-gated viewer', () => {
    expect(matchPremiumRequired(ctx(false, ['a', 'b', 'c', 'd']), 'z')).toBe(false)
  })

  it('allows continuing a chat already messaged in, even past the limit', () => {
    expect(matchPremiumRequired(ctx(true, ['a', 'b', 'c']), 'b')).toBe(false)
  })

  it('allows a new chat while under the free limit', () => {
    expect(matchPremiumRequired(ctx(true, ['a']), 'new')).toBe(false)
  })

  it('blocks a new chat once the free limit is reached', () => {
    expect(matchPremiumRequired(ctx(true, ['a', 'b']), 'third')).toBe(true)
  })

  it('the 2nd new partner is still free, the 3rd is not', () => {
    expect(matchPremiumRequired(ctx(true, ['a']), 'second')).toBe(false)
    expect(matchPremiumRequired(ctx(true, ['a', 'b']), 'third')).toBe(true)
  })
})

const LIMITED_MAN = { gender: 'man', looking_for: 'women', premium_until: null }

/** A user plus matches named by key; `sent` lists the keys they've messaged in. */
async function seed(user: Record<string, unknown>, opts: { matches?: string[]; sent?: string[]; icebreakersIn?: string[] } = {}) {
  const me = await createUser(user)
  const ids: Record<string, string> = {}
  for (const key of opts.matches ?? []) {
    const partner = await createUser({ gender: 'woman', looking_for: 'men' })
    ids[key] = (await createMatch(me.id, partner.id)).id
  }
  for (const key of opts.sent ?? []) {
    await insertRow('messages', { match_id: ids[key], sender_id: me.id, body: 'hi' })
  }
  for (const key of opts.icebreakersIn ?? []) {
    await insertRow('messages', { match_id: ids[key], sender_id: me.id, body: 'Q?', type: 'icebreaker' })
  }
  return { me, ids }
}

describe('chatGateContext', () => {
  beforeEach(() => resetDb())

  it('returns gated context with deduped chatted matches for a limited free man', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1', 'm2', 'm3'], sent: ['m1', 'm1', 'm2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const ctx = await chatGateContext(me.id, NOW)
    expect(ctx.gated).toBe(true)
    expect([...ctx.chattedMatchIds].sort()).toEqual([ids.m1, ids.m2].sort())
  })

  it('does not count auto-posted icebreaker messages as chatting', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1', 'm2'], sent: ['m1'], icebreakersIn: ['m2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const ctx = await chatGateContext(me.id, NOW)
    expect([...ctx.chattedMatchIds]).toEqual([ids.m1])
  })

  it('only counts messages the viewer sent', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1'] })
    const [partner] = await sql`select user2_id from matches where id = ${ids.m1}`
    await insertRow('messages', { match_id: ids.m1, sender_id: partner.user2_id, body: 'hello' })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect((await chatGateContext(me.id, NOW)).chattedMatchIds.size).toBe(0)
  })

  it('is not gated when the premium toggle is off', async () => {
    const { me } = await seed(LIMITED_MAN)
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    expect(await chatGateContext(me.id, NOW)).toEqual({ gated: false, chattedMatchIds: new Set() })
  })

  it('is not gated when the user is premium-active', async () => {
    const { me } = await seed({ ...LIMITED_MAN, premium_until: iso(NOW + 60_000) })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect((await chatGateContext(me.id, NOW)).gated).toBe(false)
  })

  it('is not gated for a woman seeking only men and never touches the toggle', async () => {
    const { me } = await seed({ ...LIMITED_MAN, gender: 'woman', looking_for: 'men' })
    expect((await chatGateContext(me.id, NOW)).gated).toBe(false)
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('fails open (not gated) when the user is missing', async () => {
    expect((await chatGateContext('00000000-0000-0000-0000-000000000000', NOW)).gated).toBe(false)
  })

  it('fails open (not gated) when the user read errors (malformed id → 22P02 is caught)', async () => {
    expect((await chatGateContext('u1', NOW)).gated).toBe(false)
  })
})

describe('chatSendBlocked', () => {
  beforeEach(() => resetDb())

  it('blocks a limited free man starting a 3rd conversation', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1', 'm2', 'm3'], sent: ['m1', 'm2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked(me.id, ids.m3, NOW)).toBe(true)
  })

  it('allows replying in one of his existing conversations', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1', 'm2'], sent: ['m1', 'm2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked(me.id, ids.m2, NOW)).toBe(false)
  })

  it('allows a 2nd new conversation (still within the free limit)', async () => {
    const { me, ids } = await seed(LIMITED_MAN, { matches: ['m1', 'm2'], sent: ['m1'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked(me.id, ids.m2, NOW)).toBe(false)
  })

  it('never blocks an exempt viewer', async () => {
    const { me, ids } = await seed({ ...LIMITED_MAN, gender: 'woman', looking_for: 'men' }, { matches: ['m1', 'm2', 'm3', 'm4'], sent: ['m1', 'm2', 'm3'] })
    expect(await chatSendBlocked(me.id, ids.m4, NOW)).toBe(false)
  })

  it('exposes the free limit as 2', () => {
    expect(FREE_CHAT_LIMIT).toBe(2)
  })
})
