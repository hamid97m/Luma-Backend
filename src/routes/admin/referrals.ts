import type { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
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

  app.get('/referrals/stats', async (req, reply) => {
    let total: number
    let qualifiedRows: { referrer_id: string }[]
    let rewardsGranted: number
    try {
      const [[t], q, [r]] = await Promise.all([
        sql<{ count: number }[]>`select count(*)::int as count from referrals`,
        sql<{ referrer_id: string }[]>`
          select referrer_id from referrals where qualified_at is not null limit 10000`,
        sql<{ count: number }[]>`select count(*)::int as count from referral_rewards`,
      ])
      total = t.count
      qualifiedRows = q
      rewardsGranted = r.count
    } catch (err) {
      req.log.error({ err }, 'referral stats fetch failed')
      return reply.code(500).send({ error: 'stats_fetch_failed' })
    }
    const byReferrer = new Map<string, number>()
    for (const row of qualifiedRows) {
      byReferrer.set(row.referrer_id, (byReferrer.get(row.referrer_id) ?? 0) + 1)
    }
    const top = [...byReferrer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    let topReferrers: { userId: string; name: string; qualifiedCount: number }[] = []
    if (top.length > 0) {
      // Name lookup was best-effort (failure → '?').
      const users = await sql<{ id: string; name: string }[]>`
        select id, name from users where id = any(${top.map(([id]) => id)}::uuid[])`.catch(() => [])
      const names = new Map(users.map((u) => [u.id, u.name]))
      topReferrers = top.map(([userId, qualifiedCount]) => ({
        userId, name: names.get(userId) ?? '?', qualifiedCount,
      }))
    }
    return {
      total,
      qualified: qualifiedRows.length,
      rewardsGranted,
      topReferrers,
    }
  })
}
