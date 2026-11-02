import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
import * as storage from '../../storage.js'
import { EVIDENCE_BUCKET } from '../../moderation/photoAiCheck.js'

const PAGE_SIZE = 24
const SIGNED_URL_TTL_S = 3600
// deepseek-flash peak rates in USD per token (off-peak is half), so the
// reported spend is an upper bound.
const INPUT_USD_PER_TOKEN = 0.3 / 1_000_000
const OUTPUT_USD_PER_TOKEN = 1.2 / 1_000_000

export async function adminPhotoChecksRoutes(app: FastifyInstance) {
  app.get('/photo-checks/stats', async (_req, reply) => {
    let s: any
    try {
      ;[s] = await sql`select * from photo_ai_check_stats`
    } catch (err) {
      _req.log.error({ err }, 'photo check stats failed')
    }
    if (!s) return reply.status(500).send({ error: 'photo_checks_fetch_failed' })

    const promptTokens = Number(s.prompt_tokens ?? 0)
    const completionTokens = Number(s.completion_tokens ?? 0)
    return {
      total: Number(s.total ?? 0),
      approved: Number(s.approved ?? 0),
      rejected: Number(s.rejected ?? 0),
      last24h: { total: Number(s.total_24h ?? 0), rejected: Number(s.rejected_24h ?? 0) },
      last7d: { total: Number(s.total_7d ?? 0), rejected: Number(s.rejected_7d ?? 0) },
      byReason: s.by_reason ?? {},
      promptTokens,
      completionTokens,
      estimatedCostUsd: promptTokens * INPUT_USD_PER_TOKEN + completionTokens * OUTPUT_USD_PER_TOKEN,
    }
  })

  app.get('/photo-checks', async (req, reply) => {
    const { verdict = 'all', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    const verdictFilter =
      verdict === 'approved' ? sql`where c.approved = true`
      : verdict === 'rejected' ? sql`where c.approved = false`
      : sql``

    let rows: any[]
    let total: number
    try {
      const [data, [{ count }]] = await Promise.all([
        sql`
          select c.photo_id, c.approved, c.reason, c.photo_url, c.evidence_path, c.created_at,
                 u.id as user_id, u.name as user_name, u.gender as user_gender,
                 u.paused_at as user_paused_at, u.banned_at as user_banned_at, u.deleted_at as user_deleted_at
          from photo_ai_checks c
          left join users u on u.id = c.user_id
          ${verdictFilter}
          order by c.created_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from photo_ai_checks c ${verdictFilter}`,
      ])
      // Nest the user as the old embedded `user:users(...)` did (null when missing).
      rows = data.map((r: any) => ({
        ...r,
        user: r.user_id == null ? null : {
          id: r.user_id, name: r.user_name, gender: r.user_gender,
          paused_at: r.user_paused_at, banned_at: r.user_banned_at, deleted_at: r.user_deleted_at,
        },
      }))
      total = count
    } catch (err) {
      req.log.error({ err }, 'photo checks fetch failed')
      return reply.status(500).send({ error: 'photo_checks_fetch_failed' })
    }

    const paths = rows.map((r) => r.evidence_path).filter(Boolean) as string[]
    let signed: Record<string, string> = {}
    if (paths.length) {
      // Unsafe/odd paths just get no URL (Supabase omitted failed entries too).
      signed = Object.fromEntries(
        paths.flatMap((p) => {
          try {
            return [[p, storage.createSignedUrl(EVIDENCE_BUCKET, p, SIGNED_URL_TTL_S)]]
          } catch {
            return []
          }
        }),
      )
    }

    return {
      items: rows.map((r) => ({
        photoId: r.photo_id,
        user: {
          id: r.user?.id ?? null,
          name: r.user?.name ?? '',
          gender: r.user?.gender ?? null,
          pausedAt: r.user?.paused_at ?? null,
          bannedAt: r.user?.banned_at ?? null,
          deletedAt: r.user?.deleted_at ?? null,
        },
        approved: r.approved,
        reason: r.reason,
        createdAt: r.created_at,
        imageUrl: (r.evidence_path && signed[r.evidence_path]) || r.photo_url || null,
      })),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })
}
