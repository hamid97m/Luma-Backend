import type { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { getReferralConfig } from '../referrals/config.js'
import { ensureReferralCode } from '../referrals/attribution.js'
import { MILESTONES, evaluateReferralRewards } from '../referrals/rewards.js'
import { getBotUsername } from '../bot.js'

export async function referralRoutes(app: FastifyInstance) {
  app.get('/referrals/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const config = await getReferralConfig()
    const enabled = config?.enabled === true

    if (enabled) await evaluateReferralRewards(req.userId) // lazy catch-up for rewards accrued while off

    const [code, totals, rewards] = await Promise.all([
      ensureReferralCode(req.userId),
      // A failed read rendered as empty before (supabase-js never threw).
      sql<{ qualified_at: string | null }[]>`
        select qualified_at from referrals where referrer_id = ${req.userId} limit 1000`.catch(() => []),
      sql<{ milestone: number }[]>`
        select milestone from referral_rewards where referrer_id = ${req.userId}`.catch(() => []),
    ])
    const rows = totals
    const qualifiedCount = rows.filter((r) => r.qualified_at !== null).length
    const granted = new Set(rewards.map((r) => r.milestone))
    const username = getBotUsername()

    return {
      enabled,
      code,
      link: code && username ? `https://t.me/${username}?start=ref_${code}` : null,
      qualifiedCount,
      totalCount: rows.length,
      milestones: MILESTONES.map((m) => ({
        ...m,
        achieved: qualifiedCount >= m.count,
        granted: granted.has(m.count),
      })),
    }
  })
}
