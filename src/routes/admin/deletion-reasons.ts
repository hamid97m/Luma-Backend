import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { sql } from '../../db.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 30
const MAX_DAYS = 365
const RECENT_LIMIT = 50

function parseDays(raw: unknown): number {
  const days = Number.parseInt(String(raw), 10)
  return Number.isNaN(days) ? DEFAULT_DAYS : Math.min(MAX_DAYS, Math.max(1, days))
}

export async function adminDeletionReasonsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>('/deletion-reasons', async (req: FastifyRequest<{ Querystring: { days?: string } }>, reply: FastifyReply) => {
    const days = parseDays(req.query.days)
    const since = new Date(Date.now() - days * DAY_MS).toISOString()

    try {
      const [byReason, recent] = await Promise.all([
        // null reason = deleted without answering.
        sql<{ reason: string | null; count: number; men: number; women: number; premium: number }[]>`
          select reason,
                 count(*)::int as count,
                 count(*) filter (where gender = 'man')::int as men,
                 count(*) filter (where gender = 'woman')::int as women,
                 count(*) filter (where was_premium)::int as premium
          from account_deletion_reasons
          where created_at >= ${since}
          group by reason
          order by count desc, reason nulls last`,
        // The profile name is wiped on delete (back if they signed up again);
        // the Telegram username and id survive.
        sql<any[]>`
          select r.id, r.user_id, u.name, u.username, u.telegram_id, r.reason, r.note, r.gender,
                 r.was_premium, r.days_since_signup, r.created_at
          from account_deletion_reasons r
          left join users u on u.id = r.user_id
          where r.created_at >= ${since}
          order by r.created_at desc, r.id desc
          limit ${RECENT_LIMIT}`,
      ])

      return {
        days,
        total: byReason.reduce((sum, r) => sum + r.count, 0),
        byReason,
        recent: recent.map((r) => ({
          id: Number(r.id),
          userId: r.user_id ?? null,
          userName: r.name ?? '',
          username: r.username ?? null,
          telegramId: r.telegram_id == null ? null : Number(r.telegram_id),
          reason: r.reason,
          note: r.note,
          gender: r.gender,
          wasPremium: r.was_premium,
          daysSinceSignup: r.days_since_signup,
          createdAt: r.created_at,
        })),
      }
    } catch (err) {
      req.log.error({ err }, 'deletion reasons fetch failed')
      return reply.status(500).send({ error: 'deletion_reasons_fetch_failed' })
    }
  })
}
