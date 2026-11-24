import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
import { isTextField } from '../../moderation/profileTextCheck.js'

const PAGE_SIZE = 30
// deepseek-flash peak rates in USD per token (off-peak is half), so the
// reported spend is an upper bound.
const INPUT_USD_PER_TOKEN = 0.3 / 1_000_000
const OUTPUT_USD_PER_TOKEN = 1.2 / 1_000_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function adminTextChecksRoutes(app: FastifyInstance) {
  app.get('/text-checks/stats', async (req, reply) => {
    let s: any
    let reasons: { reason: string; count: number }[]
    let fields: { field: string; count: number }[]
    try {
      ;[[s], reasons, fields] = await Promise.all([
        sql`
          select count(*)::int as total,
                 count(*) filter (where approved)::int as approved,
                 count(*) filter (where not approved)::int as rejected,
                 count(*) filter (where created_at > now() - interval '24 hours')::int as total_24h,
                 count(*) filter (where not approved and created_at > now() - interval '24 hours')::int as rejected_24h,
                 count(*) filter (where created_at > now() - interval '7 days')::int as total_7d,
                 count(*) filter (where not approved and created_at > now() - interval '7 days')::int as rejected_7d,
                 coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
                 coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
          from profile_text_checks`,
        sql<{ reason: string; count: number }[]>`
          select reason, count(*)::int as count from profile_text_checks
          where not approved and reason is not null group by reason`,
        sql<{ field: string; count: number }[]>`
          select field, count(*)::int as count from profile_text_checks
          where not approved group by field`,
      ])
    } catch (err) {
      req.log.error({ err }, 'text check stats failed')
      return reply.status(500).send({ error: 'text_checks_fetch_failed' })
    }

    const promptTokens = Number(s.prompt_tokens ?? 0)
    const completionTokens = Number(s.completion_tokens ?? 0)
    return {
      total: s.total,
      approved: s.approved,
      rejected: s.rejected,
      last24h: { total: s.total_24h, rejected: s.rejected_24h },
      last7d: { total: s.total_7d, rejected: s.rejected_7d },
      byReason: Object.fromEntries(reasons.map((r) => [r.reason, r.count])),
      byField: Object.fromEntries(fields.map((f) => [f.field, f.count])),
      promptTokens,
      completionTokens,
      estimatedCostUsd: promptTokens * INPUT_USD_PER_TOKEN + completionTokens * OUTPUT_USD_PER_TOKEN,
    }
  })

  app.get('/text-checks', async (req, reply) => {
    const { verdict = 'all', field = 'all', userId, page = '1' } = req.query as Record<string, string | undefined>
    if (userId && !UUID_RE.test(userId)) return reply.status(400).send({ error: 'invalid_user_id' })
    const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    const conds = [sql`true`]
    if (verdict === 'approved') conds.push(sql`c.approved = true`)
    else if (verdict === 'rejected') conds.push(sql`c.approved = false`)
    if (field && field !== 'all' && isTextField(field)) conds.push(sql`c.field = ${field}`)
    if (userId) conds.push(sql`c.user_id = ${userId}`)
    const where = conds.reduce((acc, c) => sql`${acc} and ${c}`)

    try {
      const [rows, [{ count }]] = await Promise.all([
        sql`
          select c.id, c.field, c.text, c.approved, c.reason, c.source, c.created_at,
                 u.id as user_id, u.name as user_name, u.gender as user_gender,
                 u.banned_at as user_banned_at, u.deleted_at as user_deleted_at
          from profile_text_checks c
          left join users u on u.id = c.user_id
          where ${where}
          order by c.created_at desc, c.id
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from profile_text_checks c where ${where}`,
      ])
      return {
        items: rows.map((r: any) => ({
          id: r.id,
          user: {
            id: r.user_id ?? null,
            name: r.user_name ?? '',
            gender: r.user_gender ?? null,
            bannedAt: r.user_banned_at ?? null,
            deletedAt: r.user_deleted_at ?? null,
          },
          field: r.field,
          text: r.text,
          approved: r.approved,
          reason: r.reason,
          source: r.source,
          createdAt: r.created_at,
        })),
        total: count,
        page: pageNum,
        pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)),
      }
    } catch (err) {
      req.log.error({ err }, 'text checks fetch failed')
      return reply.status(500).send({ error: 'text_checks_fetch_failed' })
    }
  })
}
