import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

const { getReferralConfig, ensureReferralCode, evaluateReferralRewards, getBotUsername } = vi.hoisted(() => ({
  getReferralConfig: vi.fn(),
  ensureReferralCode: vi.fn(),
  evaluateReferralRewards: vi.fn(() => Promise.resolve()),
  getBotUsername: vi.fn(),
}))
vi.mock('../src/referrals/config.js', () => ({ getReferralConfig }))
vi.mock('../src/referrals/attribution.js', () => ({ ensureReferralCode }))
vi.mock('../src/referrals/rewards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/referrals/rewards.js')>()
  return { ...actual, evaluateReferralRewards }
})
vi.mock('../src/bot.js', () => ({ getBotUsername }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  // auth preHandler: users lookup by telegram_id
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /referrals/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/referrals/me' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the full shape when enabled, and calls evaluateReferralRewards', async () => {
    setupAuth()
    getReferralConfig.mockResolvedValue({ enabled: true })
    ensureReferralCode.mockResolvedValue('x9km2pqr')
    getBotUsername.mockReturnValue('LumaBot')
    vi.mocked(db.from)
      .mockReturnValueOnce({ // referrals totals
        select: () => ({
          eq: () => ({
            limit: () => Promise.resolve({
              data: [
                { qualified_at: '2026-01-01T00:00:00.000Z' },
                { qualified_at: '2026-01-02T00:00:00.000Z' },
                { qualified_at: null },
                { qualified_at: null },
              ],
            }),
          }),
        }),
      } as any)
      .mockReturnValueOnce({ // referral_rewards
        select: () => ({ eq: () => Promise.resolve({ data: [{ milestone: 1 }] }) }),
      } as any)

    const res = await app.inject({ method: 'GET', url: '/referrals/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      enabled: true,
      code: 'x9km2pqr',
      link: 'https://t.me/LumaBot?start=ref_x9km2pqr',
      qualifiedCount: 2,
      totalCount: 4,
      milestones: [
        { count: 1, rewardType: 'swipes', rewardAmount: 20, achieved: true, granted: true },
        { count: 3, rewardType: 'premium_days', rewardAmount: 3, achieved: false, granted: false },
        { count: 10, rewardType: 'premium_days', rewardAmount: 30, achieved: false, granted: false },
      ],
    })
    expect(evaluateReferralRewards).toHaveBeenCalledWith(USER_ID)
    expect(evaluateReferralRewards).toHaveBeenCalledTimes(1)
  })

  it('returns enabled:false with the rest populated, and skips evaluateReferralRewards', async () => {
    setupAuth()
    getReferralConfig.mockResolvedValue({ enabled: false })
    ensureReferralCode.mockResolvedValue('abcd1234')
    getBotUsername.mockReturnValue('LumaBot')
    vi.mocked(db.from)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [{ qualified_at: null }] }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => Promise.resolve({ data: [] }) }),
      } as any)

    const res = await app.inject({ method: 'GET', url: '/referrals/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      enabled: false,
      code: 'abcd1234',
      link: 'https://t.me/LumaBot?start=ref_abcd1234',
      qualifiedCount: 0,
      totalCount: 1,
      milestones: [
        { count: 1, rewardType: 'swipes', rewardAmount: 20, achieved: false, granted: false },
        { count: 3, rewardType: 'premium_days', rewardAmount: 3, achieved: false, granted: false },
        { count: 10, rewardType: 'premium_days', rewardAmount: 30, achieved: false, granted: false },
      ],
    })
    expect(evaluateReferralRewards).not.toHaveBeenCalled()
  })
})
