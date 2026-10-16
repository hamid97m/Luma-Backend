import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { EVIDENCE_BUCKET } from '../../moderation/photoAiCheck.js'

const PAGE_SIZE = 24
const SIGNED_URL_TTL_S = 3600
// deepseek-flash peak rates in USD per token (off-peak is half), so the
// reported spend is an upper bound.
const INPUT_USD_PER_TOKEN = 0.3 / 1_000_000
const OUTPUT_USD_PER_TOKEN = 1.2 / 1_000_000

export async function adminPhotoChecksRoutes(app: FastifyInstance) {
  app.get('/photo-checks/stats', async (_req, reply) => {
    const { data: s, error } = await db.from('photo_ai_check_stats').select('*').single()
    if (error || !s) return reply.status(500).send({ error: 'photo_checks_fetch_failed' })

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

    let q = db
      .from('photo_ai_checks')
      .select(
        'photo_id, approved, reason, photo_url, evidence_path, created_at, ' +
        'user:users(id, name, gender, paused_at, banned_at, deleted_at)',
        { count: 'exact' },
      )
    if (verdict === 'approved') q = q.eq('approved', true)
    else if (verdict === 'rejected') q = q.eq('approved', false)

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'photo_checks_fetch_failed' })
    const rows = (data ?? []) as any[]

    const paths = rows.map((r) => r.evidence_path).filter(Boolean) as string[]
    let signed: Record<string, string> = {}
    if (paths.length) {
      const { data: urls } = await db.storage.from(EVIDENCE_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_S)
      signed = Object.fromEntries(
        (urls ?? []).filter((u) => u.path && u.signedUrl).map((u) => [u.path as string, u.signedUrl as string]),
      )
    }

    const total = count ?? 0
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
