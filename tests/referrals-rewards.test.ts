import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

const { getReferralConfig, notifyReferralQualified, notifyReferralReward } = vi.hoisted(() => ({
  getReferralConfig: vi.fn(),
  notifyReferralQualified: vi.fn(() => Promise.resolve()),
  notifyReferralReward: vi.fn(() => Promise.resolve()),
}))
vi.mock('../src/referrals/config.js', () => ({ getReferralConfig }))
vi.mock('../src/bot.js', () => ({ notifyReferralQualified, notifyReferralReward }))

import { db } from '../src/db.js'
import { extendPremiumUntil } from '../src/premium/service.js'
import {
  MILESTONES,
  dueMilestones,
  evaluateReferralRewards,
  maybeQualifyReferral,
} from '../src/referrals/rewards.js'

// Records every db.from(table).<method>(...args) call and resolves each call
// to the next queued result for that table (FIFO) — lets a test script the
// exact sequence of selects/inserts/updates evaluateReferralRewards issues.
function chainableLogged(result: unknown, log: Array<{ table: string; method: string; args: unknown[] }>, table: string): any {
  const proxy: any = new Proxy(function () {} as any, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
      return (...args: unknown[]) => {
        log.push({ table, method: String(prop), args })
        return proxy
      }
    },
  })
  return proxy
}

function makeDb(queues: Record<string, any[]>) {
  const log: Array<{ table: string; method: string; args: unknown[] }> = []
  const counters: Record<string, number> = {}
  vi.mocked(db.from).mockImplementation((table: string) => {
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const result = (queues[table] ?? [])[idx] ?? { data: null, error: null, count: null }
    return chainableLogged(result, log, table)
  })
  return log
}

function inserts(log: ReturnType<typeof makeDb>, table: string) {
  return log.filter((l) => l.table === table && l.method === 'insert').map((l) => l.args[0])
}

function updates(log: ReturnType<typeof makeDb>, table: string) {
  return log.filter((l) => l.table === table && l.method === 'update').map((l) => l.args[0])
}

describe('dueMilestones', () => {
  it('returns [] for 0 qualified referrals', () => {
    expect(dueMilestones(0, [])).toEqual([])
  })

  it('returns milestone 1 for 1 qualified referral with none granted', () => {
    expect(dueMilestones(1, [])).toEqual([MILESTONES[0]])
  })

  it('returns [] when 5 qualified but 1 and 3 already granted', () => {
    expect(dueMilestones(5, [1, 3])).toEqual([])
  })

  it('returns milestones 3 and 10 when 10 qualified but only 1 granted', () => {
    expect(dueMilestones(10, [1])).toEqual([MILESTONES[1], MILESTONES[2]])
  })
})

describe('evaluateReferralRewards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'))
  })

  it('no-ops (no db writes) when the referral config is disabled', async () => {
    getReferralConfig.mockResolvedValue({ enabled: false })
    await evaluateReferralRewards('referrer-1')
    expect(db.from).not.toHaveBeenCalled()
  })

  it('no-ops when the referral config is null', async () => {
    getReferralConfig.mockResolvedValue(null)
    await evaluateReferralRewards('referrer-1')
    expect(db.from).not.toHaveBeenCalled()
  })

  it('with 3 qualified and no prior rewards: grants milestones 1 & 3, records tx, notifies', async () => {
    getReferralConfig.mockResolvedValue({ enabled: true })
    const log = makeDb({
      referrals: [{ count: 3, data: null, error: null }],
      referral_rewards: [
        { data: [], error: null }, // granted milestones lookup
        { error: null }, // claim insert for milestone 1
        { error: null }, // claim insert for milestone 3
      ],
      users: [
        { data: { telegram_id: 555, allows_write_to_pm: true }, error: null }, // referrer lookup
        { data: { bonus_swipes: 0 }, error: null }, // grantBonusSwipes select
        { data: { id: 'referrer-1' }, error: null }, // grantBonusSwipes guarded update
        { data: { premium_until: null }, error: null }, // grantPremiumDays select
        { error: null }, // grantPremiumDays update
      ],
      premium_transactions: [{ error: null }],
    })

    await evaluateReferralRewards('referrer-1')

    expect(inserts(log, 'referral_rewards')).toEqual([
      { referrer_id: 'referrer-1', milestone: 1 },
      { referrer_id: 'referrer-1', milestone: 3 },
    ])

    expect(updates(log, 'users')).toEqual([
      { bonus_swipes: 20 },
      { premium_until: extendPremiumUntil(null, 3) },
    ])

    expect(inserts(log, 'premium_transactions')).toEqual([
      {
        user_id: 'referrer-1',
        plan_id: null,
        plan_title: 'Referral reward',
        price_stars: 0,
        duration_days: 3,
        status: 'paid',
        source: 'referral',
        paid_at: new Date().toISOString(),
      },
    ])

    expect(notifyReferralReward).toHaveBeenCalledTimes(2)
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[0])
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[1])
  })

  it('a duplicate-claim insert error (23505) grants nothing for that milestone', async () => {
    getReferralConfig.mockResolvedValue({ enabled: true })
    const log = makeDb({
      referrals: [{ count: 1, data: null, error: null }],
      referral_rewards: [
        { data: [], error: null }, // granted milestones lookup
        { error: { code: '23505', message: 'duplicate key' } }, // claim insert loses the race
      ],
      users: [{ data: { telegram_id: 555, allows_write_to_pm: true }, error: null }], // referrer lookup only
    })

    await evaluateReferralRewards('referrer-1')

    expect(inserts(log, 'referral_rewards')).toEqual([{ referrer_id: 'referrer-1', milestone: 1 }])
    // No further users reads/writes (grantBonusSwipes never ran): only the one
    // referrer lookup select touched the users table.
    expect(log.filter((l) => l.table === 'users' && l.method === 'select')).toHaveLength(1)
    expect(updates(log, 'users')).toEqual([])
    expect(notifyReferralReward).not.toHaveBeenCalled()
  })

  it('logs (but does not throw or skip the grant/notify) when the premium_transactions audit insert errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getReferralConfig.mockResolvedValue({ enabled: true })
    makeDb({
      referrals: [{ count: 3, data: null, error: null }],
      referral_rewards: [
        { data: [{ milestone: 1 }], error: null }, // milestone 1 already granted
        { error: null }, // claim insert for milestone 3
      ],
      users: [
        { data: { telegram_id: 555, allows_write_to_pm: true }, error: null }, // referrer lookup
        { data: { premium_until: null }, error: null }, // grantPremiumDays select
        { error: null }, // grantPremiumDays update
      ],
      premium_transactions: [{ error: { message: 'insert failed' } }],
    })

    await evaluateReferralRewards('referrer-1')

    expect(errorSpy).toHaveBeenCalledWith('referral premium audit insert failed', { message: 'insert failed' })
    // The reward still grants and notifies despite the audit-row failure.
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[1])
  })

  it('logs when grantBonusSwipes exhausts both attempts without a successful update', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getReferralConfig.mockResolvedValue({ enabled: true })
    makeDb({
      referrals: [{ count: 1, data: null, error: null }],
      referral_rewards: [
        { data: [], error: null }, // granted milestones lookup
        { error: null }, // claim insert for milestone 1
      ],
      users: [
        { data: { telegram_id: 555, allows_write_to_pm: true }, error: null }, // referrer lookup
        { data: { bonus_swipes: 5 }, error: null }, // attempt 1 select
        { data: null, error: null }, // attempt 1 guarded update loses the race
        { data: { bonus_swipes: 5 }, error: null }, // attempt 2 select
        { data: null, error: null }, // attempt 2 guarded update loses the race
      ],
    })

    await evaluateReferralRewards('referrer-1')

    // Claim was already inserted (idempotency guard), so the milestone is
    // considered granted even though the underlying swipe increment never
    // landed — the failure must be logged so it isn't silent.
    expect(errorSpy).toHaveBeenCalledWith('referral bonus grant failed after claim', {
      userId: 'referrer-1',
      amount: MILESTONES[0].rewardAmount,
    })
    // No behavior change otherwise: still notifies the user of the reward.
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[0])
  })
})

describe('maybeQualifyReferral', () => {
  beforeEach(() => vi.clearAllMocks())

  it('qualifies once: stamps qualified_at, notifies, and evaluates rewards', async () => {
    getReferralConfig.mockResolvedValue({ enabled: false }) // evaluateReferralRewards short-circuits here
    makeDb({
      users: [
        { data: { age: 25, name: 'Sara', referred_by: 'referrer-1' }, error: null }, // subject lookup
        { data: { telegram_id: 777, allows_write_to_pm: true }, error: null }, // referrer lookup
      ],
      user_photos: [{ count: 2, data: null, error: null }],
      referrals: [{ data: { referrer_id: 'referrer-1' }, error: null }], // guarded qualify update
    })

    await maybeQualifyReferral('user-1')

    expect(notifyReferralQualified).toHaveBeenCalledWith(777, 'Sara')
    expect(getReferralConfig).toHaveBeenCalledTimes(1) // proves evaluateReferralRewards ran
  })

  it('second call is a no-op: guarded update returns null, no notify, no reward evaluation', async () => {
    makeDb({
      users: [{ data: { age: 25, name: 'Sara', referred_by: 'referrer-1' }, error: null }],
      user_photos: [{ count: 2, data: null, error: null }],
      referrals: [{ data: null, error: null }], // already qualified — guard returns nothing
    })

    await maybeQualifyReferral('user-1')

    expect(notifyReferralQualified).not.toHaveBeenCalled()
    expect(getReferralConfig).not.toHaveBeenCalled()
  })

  it('does nothing for a user with age 0', async () => {
    makeDb({
      users: [{ data: { age: 0, name: 'Sara', referred_by: 'referrer-1' }, error: null }],
    })

    await maybeQualifyReferral('user-1')

    expect(notifyReferralQualified).not.toHaveBeenCalled()
    expect(getReferralConfig).not.toHaveBeenCalled()
  })

  it('does nothing for a user with 0 photos', async () => {
    makeDb({
      users: [{ data: { age: 25, name: 'Sara', referred_by: 'referrer-1' }, error: null }],
      user_photos: [{ count: 0, data: null, error: null }],
    })

    await maybeQualifyReferral('user-1')

    expect(notifyReferralQualified).not.toHaveBeenCalled()
    expect(getReferralConfig).not.toHaveBeenCalled()
  })
})
