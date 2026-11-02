import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { notifyReferralQualified, notifyReferralReward } = vi.hoisted(() => ({
  notifyReferralQualified: vi.fn(() => Promise.resolve()),
  notifyReferralReward: vi.fn(() => Promise.resolve()),
}))
vi.mock('../src/bot.js', () => ({ notifyReferralQualified, notifyReferralReward }))

import { extendPremiumUntil } from '../src/premium/service.js'
import {
  MILESTONES,
  dueMilestones,
  evaluateReferralRewards,
  maybeQualifyReferral,
} from '../src/referrals/rewards.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { failWritesTo } from './helpers/gifts-referrals.js'

const enable = () => sql`update referral_config set enabled = true`

/** `n` qualified referrals for `referrerId` (plus optional unqualified ones). */
async function referrals(referrerId: string, qualified: number, unqualified = 0) {
  for (let i = 0; i < qualified + unqualified; i++) {
    const u = await createUser({ referred_by: referrerId })
    await sql`insert into referrals (referrer_id, referred_id, qualified_at)
      values (${referrerId}, ${u.id}, ${i < qualified ? new Date().toISOString() : null})`
  }
}

const userRow = async (id: string) =>
  (await sql`select bonus_swipes, premium_until from users where id = ${id}`)[0]
const rewardRows = async (id: string) =>
  (await sql`select milestone from referral_rewards where referrer_id = ${id} order by milestone`).map((r) => r.milestone)

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
  let referrer: Record<string, any>

  beforeEach(async () => {
    // Fake only Date: postgres.js needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'))
    await resetDb()
    referrer = await createUser({ telegram_id: 555, allows_write_to_pm: true, locale: 'en' })
  })
  afterEach(() => vi.useRealTimers())

  it('no-ops (no db writes) when the referral config is disabled', async () => {
    await referrals(referrer.id, 3)
    await evaluateReferralRewards(referrer.id)
    expect(await rewardRows(referrer.id)).toEqual([])
    expect(await userRow(referrer.id)).toEqual({ bonus_swipes: 0, premium_until: null })
  })

  it('no-ops when the referral config row is missing', async () => {
    await sql`delete from referral_config`
    await referrals(referrer.id, 3)
    await evaluateReferralRewards(referrer.id)
    expect(await rewardRows(referrer.id)).toEqual([])
  })

  it('no-ops with zero qualified referrals (unqualified ones do not count)', async () => {
    await enable()
    await referrals(referrer.id, 0, 2)
    await evaluateReferralRewards(referrer.id)
    expect(await rewardRows(referrer.id)).toEqual([])
  })

  it('with 3 qualified and no prior rewards: grants milestones 1 & 3, records tx, notifies', async () => {
    await enable()
    await referrals(referrer.id, 3, 1)

    await evaluateReferralRewards(referrer.id)

    expect(await rewardRows(referrer.id)).toEqual([1, 3])
    expect(await userRow(referrer.id)).toEqual({ bonus_swipes: 20, premium_until: extendPremiumUntil(null, 3) })

    const txs = await sql`
      select user_id, plan_id, plan_title, price_stars, duration_days, status, source, paid_at
      from premium_transactions`
    expect(txs).toEqual([{
      user_id: referrer.id,
      plan_id: null,
      plan_title: 'Referral reward',
      price_stars: 0,
      duration_days: 3,
      status: 'paid',
      source: 'referral',
      paid_at: new Date().toISOString(),
    }])

    // Both DMs go out in the referrer's language.
    expect(notifyReferralReward).toHaveBeenCalledTimes(2)
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[0], 'en')
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[1], 'en')
  })

  it('extends an active premium from its current end, not from now', async () => {
    await enable()
    const future = '2026-10-01T00:00:00.000Z'
    await sql`update users set premium_until = ${future} where id = ${referrer.id}`
    await sql`insert into referral_rewards (referrer_id, milestone) values (${referrer.id}, 1)`
    await referrals(referrer.id, 3)
    await evaluateReferralRewards(referrer.id)
    expect((await userRow(referrer.id)).premium_until).toBe(extendPremiumUntil(future, 3))
  })

  it('adds to existing bonus swipes', async () => {
    await enable()
    await sql`update users set bonus_swipes = 7 where id = ${referrer.id}`
    await referrals(referrer.id, 1)
    await evaluateReferralRewards(referrer.id)
    expect((await userRow(referrer.id)).bonus_swipes).toBe(27)
  })

  it('a second evaluation grants nothing more', async () => {
    await enable()
    await referrals(referrer.id, 3)
    await evaluateReferralRewards(referrer.id)
    vi.mocked(notifyReferralReward).mockClear()
    await evaluateReferralRewards(referrer.id)
    expect(await userRow(referrer.id)).toEqual({ bonus_swipes: 20, premium_until: extendPremiumUntil(null, 3) })
    expect(await sql`select id from premium_transactions`).toHaveLength(1)
    expect(notifyReferralReward).not.toHaveBeenCalled()
  })

  it('concurrent evaluations (duplicate claim race) grant each milestone exactly once', async () => {
    await enable()
    await referrals(referrer.id, 3)
    await Promise.all([1, 2, 3, 4].map(() => evaluateReferralRewards(referrer.id)))
    expect(await rewardRows(referrer.id)).toEqual([1, 3])
    expect(await userRow(referrer.id)).toEqual({ bonus_swipes: 20, premium_until: extendPremiumUntil(null, 3) })
    expect(await sql`select id from premium_transactions`).toHaveLength(1)
    expect(notifyReferralReward).toHaveBeenCalledTimes(2)
  })

  it('does not notify when the referrer blocked the bot', async () => {
    await enable()
    await sql`update users set allows_write_to_pm = false where id = ${referrer.id}`
    await referrals(referrer.id, 1)
    await evaluateReferralRewards(referrer.id)
    expect((await userRow(referrer.id)).bonus_swipes).toBe(20)
    expect(notifyReferralReward).not.toHaveBeenCalled()
  })

  it('logs (but does not throw or skip the grant/notify) when the premium_transactions audit insert errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await enable()
    await sql`update users set locale = 'ar' where id = ${referrer.id}`
    await sql`insert into referral_rewards (referrer_id, milestone) values (${referrer.id}, 1)` // already granted
    await referrals(referrer.id, 3)
    const cleanup = await failWritesTo('premium_transactions', 'INSERT')
    try {
      await evaluateReferralRewards(referrer.id)
    } finally {
      await cleanup()
    }

    expect(errorSpy).toHaveBeenCalledWith('referral premium audit insert failed', expect.objectContaining({
      message: 'injected failure on premium_transactions',
    }))
    // The reward still grants and notifies despite the audit-row failure.
    expect((await userRow(referrer.id)).premium_until).toBe(extendPremiumUntil(null, 3))
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[1], 'ar')
    errorSpy.mockRestore()
  })

  it('logs when the bonus-swipes grant fails after the claim, and still notifies', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await enable()
    await sql`update users set locale = null where id = ${referrer.id}`
    await referrals(referrer.id, 1)
    const cleanup = await failWritesTo('users', 'UPDATE')
    try {
      await evaluateReferralRewards(referrer.id)
    } finally {
      await cleanup()
    }

    // Claim was already inserted (idempotency guard), so the milestone is
    // considered granted even though the underlying swipe increment never
    // landed — the failure must be logged so it isn't silent.
    expect(await rewardRows(referrer.id)).toEqual([1])
    expect(errorSpy).toHaveBeenCalledWith('referral bonus grant failed after claim', {
      userId: referrer.id,
      amount: MILESTONES[0].rewardAmount,
    })
    // Still notifies (null locale → Persian for a referrer who hasn't picked a language).
    expect(notifyReferralReward).toHaveBeenCalledWith(555, MILESTONES[0], null)
    errorSpy.mockRestore()
  })
})

describe('maybeQualifyReferral', () => {
  let referrer: Record<string, any>
  let subject: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    referrer = await createUser({ telegram_id: 777, allows_write_to_pm: true, locale: 'en' })
    subject = await createUser({ name: 'Sara', age: 25, referred_by: referrer.id, gender: 'woman', looking_for: 'men' })
    await sql`insert into referrals (referrer_id, referred_id) values (${referrer.id}, ${subject.id})`
  })

  const qualifiedAt = async () =>
    (await sql`select qualified_at from referrals where referred_id = ${subject.id}`)[0].qualified_at

  it('qualifies once: stamps qualified_at and notifies the referrer in their language', async () => {
    await createPhoto(subject.id, 0)
    await createPhoto(subject.id, 1)

    await maybeQualifyReferral(subject.id)

    expect(await qualifiedAt()).not.toBeNull()
    expect(notifyReferralQualified).toHaveBeenCalledWith(777, 'Sara', 'en')
    expect(await rewardRows(referrer.id)).toEqual([]) // program disabled → no reward
  })

  it('evaluates rewards after qualifying when the program is enabled', async () => {
    await enable()
    await createPhoto(subject.id, 0)
    await maybeQualifyReferral(subject.id)
    expect(await rewardRows(referrer.id)).toEqual([1])
    expect((await userRow(referrer.id)).bonus_swipes).toBe(20)
  })

  it('second call is a no-op: no notify, no reward evaluation', async () => {
    await enable()
    await createPhoto(subject.id, 0)
    await maybeQualifyReferral(subject.id)
    const first = await qualifiedAt()
    vi.mocked(notifyReferralQualified).mockClear()
    vi.mocked(notifyReferralReward).mockClear()

    await maybeQualifyReferral(subject.id)

    expect(await qualifiedAt()).toBe(first)
    expect(notifyReferralQualified).not.toHaveBeenCalled()
    expect(notifyReferralReward).not.toHaveBeenCalled()
  })

  it('concurrent calls qualify (and notify) exactly once', async () => {
    await createPhoto(subject.id, 0)
    await Promise.all([maybeQualifyReferral(subject.id), maybeQualifyReferral(subject.id)])
    expect(notifyReferralQualified).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a user with age 0', async () => {
    await sql`update users set age = 0 where id = ${subject.id}`
    await createPhoto(subject.id, 0)
    await maybeQualifyReferral(subject.id)
    expect(await qualifiedAt()).toBeNull()
    expect(notifyReferralQualified).not.toHaveBeenCalled()
  })

  it('does nothing for a user with 0 photos', async () => {
    await maybeQualifyReferral(subject.id)
    expect(await qualifiedAt()).toBeNull()
    expect(notifyReferralQualified).not.toHaveBeenCalled()
  })

  it('does nothing for a user who was not referred', async () => {
    const loner = await createUser()
    await createPhoto(loner.id, 0)
    await maybeQualifyReferral(loner.id)
    expect(notifyReferralQualified).not.toHaveBeenCalled()
  })
})
