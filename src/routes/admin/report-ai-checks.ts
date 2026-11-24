import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'

const PAGE_SIZE = 20

/** Paginated log of every AI report review (moderation/reportAiReview.ts), newest first. */
export async function adminReportAiChecksRoutes(app: FastifyInstance) {
  app.get('/report-ai-checks', async (req, reply) => {
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    try {
      const [rows, [{ count }]] = await Promise.all([
        sql<any[]>`
          select c.id, c.report_id, c.reporter_id, rep.name as reporter_name, c.reported_id, red.name as reported_name,
                 c.mode, c.verdict, c.category, c.quote, c.explanation, c.skip_reason,
                 c.reporter_notified_at, c.created_at
          from report_ai_checks c
          left join users rep on rep.id = c.reporter_id
          left join users red on red.id = c.reported_id
          order by c.created_at desc, c.id desc
          limit ${PAGE_SIZE} offset ${(pageNum - 1) * PAGE_SIZE}`,
        sql<{ count: number }[]>`select count(*)::int as count from report_ai_checks`,
      ])
      return {
        items: rows.map((r) => ({
          id: r.id,
          reportId: r.report_id,
          reporter: { id: r.reporter_id, name: r.reporter_name ?? '' },
          reported: { id: r.reported_id, name: r.reported_name ?? '' },
          mode: r.mode,
          verdict: r.verdict,
          category: r.category ?? null,
          quote: r.quote ?? null,
          explanation: r.explanation ?? null,
          skipReason: r.skip_reason ?? null,
          reporterNotifiedAt: r.reporter_notified_at ?? null,
          createdAt: r.created_at,
        })),
        total: count,
        page: pageNum,
        pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)),
      }
    } catch (err) {
      req.log.error({ err }, 'report ai checks fetch failed')
      return reply.status(500).send({ error: 'report_ai_checks_fetch_failed' })
    }
  })
}
