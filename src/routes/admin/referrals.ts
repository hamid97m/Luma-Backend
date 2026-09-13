import type { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { getReferralConfig, updateReferralConfig } from '../../referrals/config.js'

export async function adminReferralRoutes(app: FastifyInstance) {
  app.get('/referrals/config', async (_req, reply) => {
    const config = await getReferralConfig()
    if (!config) return reply.code(500).send({ error: 'config_fetch_failed' })
    return config
  })

  app.put('/referrals/config', async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_enabled' })
    }
    const config = await updateReferralConfig({ enabled: body.enabled })
    if (!config) return reply.code(500).send({ error: 'config_update_failed' })
    return config
  })

  app.get('/referrals/stats', async (_req, reply) => {
    const [totalQ, qualifiedRowsQ, rewardsQ] = await Promise.all([
      db.from('referrals').select('id', { count: 'exact', head: true }),
      db.from('referrals').select('referrer_id').not('qualified_at', 'is', null).limit(10000),
      db.from('referral_rewards').select('milestone', { count: 'exact', head: true }),
    ])
    if (totalQ.error || qualifiedRowsQ.error || rewardsQ.error) {
      return reply.code(500).send({ error: 'stats_fetch_failed' })
    }
    const byReferrer = new Map<string, number>()
    for (const row of qualifiedRowsQ.data ?? []) {
      byReferrer.set(row.referrer_id, (byReferrer.get(row.referrer_id) ?? 0) + 1)
    }
    const top = [...byReferrer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    let topReferrers: { userId: string; name: string; qualifiedCount: number }[] = []
    if (top.length > 0) {
      const { data: users } = await db
        .from('users').select('id, name').in('id', top.map(([id]) => id))
      const names = new Map((users ?? []).map((u) => [u.id, u.name]))
      topReferrers = top.map(([userId, qualifiedCount]) => ({
        userId, name: names.get(userId) ?? '?', qualifiedCount,
      }))
    }
    return {
      total: totalQ.count ?? 0,
      qualified: (qualifiedRowsQ.data ?? []).length,
      rewardsGranted: rewardsQ.count ?? 0,
      topReferrers,
    }
  })
}
