import { sql } from '../db.js'
import { getReferralConfig } from './config.js'
import { extendPremiumUntil } from '../premium/service.js'
import { notifyReferralQualified, notifyReferralReward } from '../bot.js'
import type { Locale } from '../i18n/index.js'

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
  // Single atomic increment (replaces the old read + compare-and-set retry loop, which
  // could give up under contention). A missing user is a silent no-op, as before.
  try {
    await sql`update users set bonus_swipes = coalesce(bonus_swipes, 0) + ${amount} where id = ${userId}`
  } catch {
    console.error('referral bonus grant failed after claim', { userId, amount })
  }
}

async function grantPremiumDays(userId: string, days: number): Promise<void> {
  // Row lock so a concurrent premium purchase/grant can't read the same premium_until
  // and overwrite this extension (the old read-then-write could lose one of them).
  const extended = await sql.begin(async (tx) => {
    const [user] = await tx<{ premium_until: string | null }[]>`
      select premium_until from users where id = ${userId} for update`
    if (!user) return false
    await tx`
      update users set premium_until = ${extendPremiumUntil(user.premium_until ?? null, days)}
      where id = ${userId}`
    return true
  })
  if (!extended) return
  // Audit row is best-effort: its failure is logged and never undoes the grant.
  try {
    await sql`
      insert into premium_transactions ${sql({
        user_id: userId,
        plan_id: null,
        plan_title: 'Referral reward',
        price_stars: 0,
        duration_days: days,
        status: 'paid',
        source: 'referral',
        paid_at: new Date().toISOString(),
      })}`
  } catch (error) {
    console.error('referral premium audit insert failed', error)
  }
}

export async function evaluateReferralRewards(referrerId: string): Promise<void> {
  try {
    const config = await getReferralConfig()
    if (!config?.enabled) return

    const [{ count: qualifiedCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from referrals
      where referrer_id = ${referrerId} and qualified_at is not null`
    if (qualifiedCount === 0) return

    const rewardRows = await sql<{ milestone: number }[]>`
      select milestone from referral_rewards where referrer_id = ${referrerId}`
    const granted = rewardRows.map((r) => r.milestone)

    const due = dueMilestones(qualifiedCount, granted)
    if (due.length === 0) return

    const [referrer] = await sql<{ telegram_id: number; allows_write_to_pm: boolean | null; locale: Locale | null }[]>`
      select telegram_id, allows_write_to_pm, locale from users where id = ${referrerId}`

    for (const milestone of due) {
      // Atomic claim: the referral_rewards PK is the idempotency guard — only the caller
      // whose insert actually lands a row grants the reward.
      let claimed = false
      try {
        const rows = await sql`
          insert into referral_rewards (referrer_id, milestone) values (${referrerId}, ${milestone.count})
          on conflict (referrer_id, milestone) do nothing
          returning milestone`
        claimed = rows.length === 1
      } catch {
        claimed = false
      }
      if (!claimed) continue // duplicate or anything else: never double-grant

      if (milestone.rewardType === 'swipes') await grantBonusSwipes(referrerId, milestone.rewardAmount)
      else await grantPremiumDays(referrerId, milestone.rewardAmount)

      if (referrer && referrer.telegram_id > 0 && referrer.allows_write_to_pm !== false) {
        await notifyReferralReward(referrer.telegram_id, milestone, referrer.locale ?? null)
      }
    }
  } catch (err) {
    console.error('evaluateReferralRewards failed', err)
  }
}

export async function maybeQualifyReferral(userId: string): Promise<void> {
  try {
    const [user] = await sql<{ age: number | null; name: string; referred_by: string | null }[]>`
      select age, name, referred_by from users where id = ${userId}`
    if (!user?.referred_by || !((user.age ?? 0) > 0)) return

    const [{ count: photoCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_photos where user_id = ${userId}`
    if (photoCount < 1) return

    // Guarded update: qualifies exactly once, even under concurrent photo/profile calls.
    const [qualified] = await sql<{ referrer_id: string }[]>`
      update referrals set qualified_at = ${new Date().toISOString()}
      where referred_id = ${userId} and qualified_at is null
      returning referrer_id`
    if (!qualified) return

    const [referrer] = await sql<{ telegram_id: number; allows_write_to_pm: boolean | null; locale: Locale | null }[]>`
      select telegram_id, allows_write_to_pm, locale from users where id = ${qualified.referrer_id}`
    if (referrer && referrer.telegram_id > 0 && referrer.allows_write_to_pm !== false) {
      await notifyReferralQualified(referrer.telegram_id, user.name, referrer.locale ?? null)
    }
    await evaluateReferralRewards(qualified.referrer_id)
  } catch (err) {
    console.error('maybeQualifyReferral failed', err)
  }
}
