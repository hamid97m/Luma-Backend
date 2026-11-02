import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

const { evaluateReferralRewards, getBotUsername } = vi.hoisted(() => ({
  evaluateReferralRewards: vi.fn(() => Promise.resolve()),
  getBotUsername: vi.fn(),
}))
vi.mock('../src/referrals/rewards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/referrals/rewards.js')>()
  return { ...actual, evaluateReferralRewards }
})
vi.mock('../src/bot.js', () => ({ getBotUsername }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('GET /referrals/me', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    getBotUsername.mockReturnValue('LumaBot')
    me = await createUser({ name: 'Ali' })
  })

  async function referred(qualifiedAt: string | null) {
    const u = await createUser({ referred_by: me.id })
    await sql`insert into referrals (referrer_id, referred_id, qualified_at) values (${me.id}, ${u.id}, ${qualifiedAt})`
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/referrals/me' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the full shape when enabled, and calls evaluateReferralRewards', async () => {
    authAs(me)
    await sql`update referral_config set enabled = true`
    await sql`update users set referral_code = 'x9km2pqr' where id = ${me.id}`
    await referred('2026-01-01T00:00:00.000Z')
    await referred('2026-01-02T00:00:00.000Z')
    await referred(null)
    await referred(null)
    await sql`insert into referral_rewards (referrer_id, milestone) values (${me.id}, 1)`

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
    expect(evaluateReferralRewards).toHaveBeenCalledWith(me.id)
    expect(evaluateReferralRewards).toHaveBeenCalledTimes(1)
  })

  it('returns enabled:false with the rest populated (code minted on first view), and skips evaluateReferralRewards', async () => {
    authAs(me)
    await referred(null)

    const res = await app.inject({ method: 'GET', url: '/referrals/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const [{ referral_code }] = await sql`select referral_code from users where id = ${me.id}`
    expect(referral_code).toHaveLength(8)
    expect(body).toEqual({
      enabled: false,
      code: referral_code,
      link: `https://t.me/LumaBot?start=ref_${referral_code}`,
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

  it('link is null when the bot username is unknown', async () => {
    authAs(me)
    getBotUsername.mockReturnValue(undefined)
    const res = await app.inject({ method: 'GET', url: '/referrals/me', headers: AUTH })
    expect(res.json()).toMatchObject({ link: null, qualifiedCount: 0, totalCount: 0 })
  })
})
