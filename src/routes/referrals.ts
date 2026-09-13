import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
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
      db.from('referrals').select('qualified_at').eq('referrer_id', req.userId).limit(1000),
      db.from('referral_rewards').select('milestone').eq('referrer_id', req.userId),
    ])
    const rows = totals.data ?? []
    const qualifiedCount = rows.filter((r) => r.qualified_at !== null).length
    const granted = new Set((rewards.data ?? []).map((r) => r.milestone))
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
