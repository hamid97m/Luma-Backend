import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { db } from '../src/db.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import {
  FREE_CHAT_LIMIT, chatLimitApplies, matchPremiumRequired, chatGateContext, chatSendBlocked,
} from '../src/premium/chatLimit.js'

const NOW = new Date('2026-08-31T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('chatLimitApplies (shared swipe cohort)', () => {
  it('applies to men seeking women, exempts everyone else', () => {
    expect(chatLimitApplies('man', 'women')).toBe(true)
    expect(chatLimitApplies('man', 'both')).toBe(true)
    expect(chatLimitApplies('woman', 'women')).toBe(false)
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
    expect(matchPremiumRequired(ctx(true, ['a', 'b']), 'new')).toBe(false)
  })

  it('blocks a new chat once the free limit is reached', () => {
    expect(matchPremiumRequired(ctx(true, ['a', 'b', 'c']), 'fourth')).toBe(true)
  })

  it('the 3rd new partner is still free, the 4th is not', () => {
    expect(matchPremiumRequired(ctx(true, ['a', 'b']), 'third')).toBe(false)
    expect(matchPremiumRequired(ctx(true, ['a', 'b', 'c']), 'fourth')).toBe(true)
  })
})

/** Mocks the users cohort read then the messages match_id read. */
function mockDb(opts: {
  user?: Record<string, unknown> | null
  userError?: boolean
  messageMatchIds?: string[]
}) {
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table === 'users') {
      return {
        select: () => ({
          eq: () => ({
            single: () => (opts.userError
              ? { data: null, error: { message: 'boom' } }
              : { data: opts.user ?? null, error: null }),
          }),
        }),
      }
    }
    if (table === 'messages') {
      return {
        select: () => ({
          eq: () => ({ data: (opts.messageMatchIds ?? []).map((match_id) => ({ match_id })), error: null }),
        }),
      }
    }
    throw new Error(`unexpected table ${table}`)
  }) as any)
}

const LIMITED_MAN = { gender: 'man', looking_for: 'women', premium_until: null }

describe('chatGateContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns gated context with deduped chatted matches for a limited free man', async () => {
    mockDb({ user: LIMITED_MAN, messageMatchIds: ['m1', 'm1', 'm2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const ctx = await chatGateContext('u1', NOW)
    expect(ctx.gated).toBe(true)
    expect([...ctx.chattedMatchIds].sort()).toEqual(['m1', 'm2'])
  })

  it('is not gated when the premium toggle is off', async () => {
    mockDb({ user: LIMITED_MAN })
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    expect(await chatGateContext('u1', NOW)).toEqual({ gated: false, chattedMatchIds: new Set() })
  })

  it('is not gated when the user is premium-active', async () => {
    mockDb({ user: { ...LIMITED_MAN, premium_until: iso(NOW + 60_000) } })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect((await chatGateContext('u1', NOW)).gated).toBe(false)
  })

  it('is not gated for a woman and never touches the toggle', async () => {
    mockDb({ user: { ...LIMITED_MAN, gender: 'woman' } })
    expect((await chatGateContext('u1', NOW)).gated).toBe(false)
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('fails open (not gated) when the user read errors', async () => {
    mockDb({ userError: true })
    expect((await chatGateContext('u1', NOW)).gated).toBe(false)
  })
})

describe('chatSendBlocked', () => {
  beforeEach(() => vi.clearAllMocks())

  it('blocks a limited free man starting a 4th conversation', async () => {
    mockDb({ user: LIMITED_MAN, messageMatchIds: ['m1', 'm2', 'm3'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked('u1', 'm4', NOW)).toBe(true)
  })

  it('allows replying in one of his 3 existing conversations', async () => {
    mockDb({ user: LIMITED_MAN, messageMatchIds: ['m1', 'm2', 'm3'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked('u1', 'm2', NOW)).toBe(false)
  })

  it('allows a 3rd new conversation (still within the free limit)', async () => {
    mockDb({ user: LIMITED_MAN, messageMatchIds: ['m1', 'm2'] })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await chatSendBlocked('u1', 'm3', NOW)).toBe(false)
  })

  it('never blocks an exempt viewer', async () => {
    mockDb({ user: { ...LIMITED_MAN, gender: 'woman' }, messageMatchIds: ['m1', 'm2', 'm3'] })
    expect(await chatSendBlocked('u1', 'm4', NOW)).toBe(false)
  })

  it('exposes the free limit as 3', () => {
    expect(FREE_CHAT_LIMIT).toBe(3)
  })
})
