import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { db } from '../src/db.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import {
  DIRECT_CHAT_LIMIT, DIRECT_CHAT_WINDOW_MS,
  directChatLimitApplies, evaluateDirectChatWindow,
  checkAndCountDirectChat, getDirectChatStatus,
} from '../src/premium/directChatLimit.js'

const NOW = new Date('2026-09-05T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

// users-select then guarded-update chain mock (mirrors swipe-limit-service.test.ts).
function mockUserRow(row: Record<string, unknown> | null, opts?: { selectError?: boolean; updateError?: boolean; onUpdate?: (patch: any) => void }) {
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table !== 'users') throw new Error(`unexpected table ${table}`)
    return {
      select: () => ({ eq: () => ({ single: () => (opts?.selectError ? { data: null, error: { message: 'boom' } } : { data: row, error: null }) }) }),
      update: (patch: any) => {
        opts?.onUpdate?.(patch)
        return { eq: () => ({ eq: () => ({ select: () => (opts?.updateError ? { data: null, error: { message: 'boom' } } : { data: [{ id: 'u1' }], error: null }) }) }) }
      },
    }
  }) as any)
}

const QUOTA_USER = {
  gender: 'man', looking_for: 'women', premium_until: iso(NOW + 86_400_000),
  direct_chat_window_started_at: null, direct_chat_window_count: 0,
}

describe('directChatLimitApplies', () => {
  it('matches the swipe cohort (men seeking women/both/everyone)', () => {
    expect(directChatLimitApplies('man', 'women')).toBe(true)
    expect(directChatLimitApplies('man', 'everyone')).toBe(true)
    expect(directChatLimitApplies('woman', 'men')).toBe(false)
    expect(directChatLimitApplies('man', 'men')).toBe(false)
  })
})

describe('evaluateDirectChatWindow', () => {
  it('starts a fresh window on the first direct chat', () => {
    expect(evaluateDirectChatWindow(null, 0, NOW)).toEqual({
      blocked: false, resetAt: iso(NOW + DIRECT_CHAT_WINDOW_MS),
      nextStartedAt: iso(NOW), nextCount: 1, remaining: DIRECT_CHAT_LIMIT - 1,
    })
  })
  it('blocks the 4th within the window', () => {
    const start = iso(NOW - 60_000)
    expect(evaluateDirectChatWindow(start, 2, NOW).remaining).toBe(0)
    expect(evaluateDirectChatWindow(start, 3, NOW)).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
  })
})

describe('checkAndCountDirectChat', () => {
  beforeEach(() => vi.clearAllMocks())

  it('gate=free for a woman (never checks the toggle)', async () => {
    mockUserRow({ ...QUOTA_USER, gender: 'woman' })
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'free' })
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('gate=free when premium toggle is off', async () => {
    mockUserRow(QUOTA_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'free' })
  })

  it('gate=paywall for a cohort man who is not premium-active', async () => {
    mockUserRow({ ...QUOTA_USER, premium_until: null })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'paywall' })
  })

  it('gate=quota: counts and returns remaining for a premium cohort man', async () => {
    let written: any
    mockUserRow(QUOTA_USER, { onUpdate: (p) => { written = p } })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountDirectChat('u1', NOW)
    expect(res).toEqual({ gate: 'quota', blocked: false, remaining: DIRECT_CHAT_LIMIT - 1, resetAt: iso(NOW + DIRECT_CHAT_WINDOW_MS) })
    expect(written).toEqual({ direct_chat_window_started_at: iso(NOW), direct_chat_window_count: 1 })
  })

  it('gate=quota: blocks at the cap', async () => {
    mockUserRow({ ...QUOTA_USER, direct_chat_window_started_at: iso(NOW - 60_000), direct_chat_window_count: 3 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'quota', blocked: true, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
  })

  it('fails open to free on db error', async () => {
    mockUserRow(null, { selectError: true })
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'free' })
  })
})

describe('getDirectChatStatus (read-only, never counts)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports quota remaining mid-window without writing', async () => {
    let updated = false
    mockUserRow({ ...QUOTA_USER, direct_chat_window_started_at: iso(NOW - 60_000), direct_chat_window_count: 2 }, { onUpdate: () => { updated = true } })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await getDirectChatStatus('u1', NOW)
    expect(res).toEqual({ gate: 'quota', remaining: 1, limit: DIRECT_CHAT_LIMIT, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
    expect(updated).toBe(false)
  })

  it('reports gate=free with full remaining for a woman', async () => {
    mockUserRow({ ...QUOTA_USER, gender: 'woman' })
    expect(await getDirectChatStatus('u1', NOW)).toEqual({ gate: 'free', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null })
  })

  it('reports gate=paywall for a non-premium cohort man', async () => {
    mockUserRow({ ...QUOTA_USER, premium_until: null })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getDirectChatStatus('u1', NOW)).toEqual({ gate: 'paywall', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null })
  })
})
