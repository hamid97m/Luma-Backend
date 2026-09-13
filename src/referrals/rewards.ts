import { db } from '../db.js'
import { getReferralConfig } from './config.js'
import { extendPremiumUntil } from '../premium/service.js'
import { notifyReferralQualified, notifyReferralReward } from '../bot.js'

export interface Milestone {
  count: number
  rewardType: 'swipes' | 'premium_days'
  rewardAmount: number
}

export const MILESTONES: Milestone[] = [
  { count: 1, rewardType: 'swipes', rewardAmount: 20 },
  { count: 3, rewardType: 'premium_days', rewardAmount: 3 },
  { count: 10, rewardType: 'premium_days', rewardAmount: 30 },
]

export function dueMilestones(qualifiedCount: number, granted: number[]): Milestone[] {
  return MILESTONES.filter((m) => qualifiedCount >= m.count && !granted.includes(m.count))
}

async function grantBonusSwipes(userId: string, amount: number): Promise<void> {
  // Optimistic-concurrency increment, same pattern as guardedWindowUpdate in swipeLimit.ts.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: user } = await db.from('users').select('bonus_swipes').eq('id', userId).single()
    if (!user) return
    const { data: updated } = await db
      .from('users')
      .update({ bonus_swipes: (user.bonus_swipes ?? 0) + amount })
      .eq('id', userId)
      .eq('bonus_swipes', user.bonus_swipes ?? 0)
      .select('id')
      .maybeSingle()
    if (updated) return
  }
}

async function grantPremiumDays(userId: string, days: number): Promise<void> {
  const { data: user } = await db.from('users').select('premium_until').eq('id', userId).single()
  if (!user) return
  await db
    .from('users')
    .update({ premium_until: extendPremiumUntil(user.premium_until ?? null, days) })
    .eq('id', userId)
  await db.from('premium_transactions').insert({
    user_id: userId,
    plan_id: null,
    plan_title: 'Referral reward',
    price_stars: 0,
    duration_days: days,
    status: 'paid',
    source: 'referral',
    paid_at: new Date().toISOString(),
  })
}

export async function evaluateReferralRewards(referrerId: string): Promise<void> {
  try {
    const config = await getReferralConfig()
    if (!config?.enabled) return

    const { count } = await db
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('referrer_id', referrerId)
      .not('qualified_at', 'is', null)
    const qualifiedCount = count ?? 0
    if (qualifiedCount === 0) return

    const { data: rewardRows } = await db
      .from('referral_rewards')
      .select('milestone')
      .eq('referrer_id', referrerId)
    const granted = (rewardRows ?? []).map((r) => r.milestone)

    const due = dueMilestones(qualifiedCount, granted)
    if (due.length === 0) return

    const { data: referrer } = await db
      .from('users')
      .select('telegram_id, allows_write_to_pm')
      .eq('id', referrerId)
      .single()

    for (const milestone of due) {
      // Atomic claim: the PK insert is the idempotency guard.
      const { error: claimError } = await db
        .from('referral_rewards')
        .insert({ referrer_id: referrerId, milestone: milestone.count })
      if (claimError) continue // 23505 duplicate or anything else: never double-grant

      if (milestone.rewardType === 'swipes') await grantBonusSwipes(referrerId, milestone.rewardAmount)
      else await grantPremiumDays(referrerId, milestone.rewardAmount)

      if (referrer && referrer.telegram_id > 0 && referrer.allows_write_to_pm !== false) {
        await notifyReferralReward(referrer.telegram_id, milestone)
      }
    }
  } catch (err) {
    console.error('evaluateReferralRewards failed', err)
  }
}

export async function maybeQualifyReferral(userId: string): Promise<void> {
  try {
    const { data: user } = await db
      .from('users')
      .select('age, name, referred_by')
      .eq('id', userId)
      .single()
    if (!user?.referred_by || !(user.age > 0)) return

    const { count: photoCount } = await db
      .from('user_photos')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    if ((photoCount ?? 0) < 1) return

    // Guarded update: qualifies exactly once, even under concurrent photo/profile calls.
    const { data: qualified } = await db
      .from('referrals')
      .update({ qualified_at: new Date().toISOString() })
      .eq('referred_id', userId)
      .is('qualified_at', null)
      .select('referrer_id')
      .maybeSingle()
    if (!qualified) return

    const { data: referrer } = await db
      .from('users')
      .select('telegram_id, allows_write_to_pm')
      .eq('id', qualified.referrer_id)
      .single()
    if (referrer && referrer.telegram_id > 0 && referrer.allows_write_to_pm !== false) {
      await notifyReferralQualified(referrer.telegram_id, user.name)
    }
    await evaluateReferralRewards(qualified.referrer_id)
  } catch (err) {
    console.error('maybeQualifyReferral failed', err)
  }
}
