import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
import { REPORT_AI_MODES } from '../../moderation/reportAiReview.js'

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

type ConfigRow = { photo_report_threshold: number; report_ai_mode: string; report_suspend_days: number }

const toConfig = (d: ConfigRow) => ({
  photoReportThreshold: d.photo_report_threshold,
  reportAiMode: d.report_ai_mode,
  reportSuspendDays: d.report_suspend_days,
})

export async function adminModerationRoutes(app: FastifyInstance) {
  app.get('/moderation/config', async (_req, reply) => {
    let data: ConfigRow | undefined
    try {
      ;[data] = await sql<ConfigRow[]>`
        select photo_report_threshold, report_ai_mode, report_suspend_days from moderation_config where id = true`
    } catch { /* falls through to config_fetch_failed */ }
    if (!data) return reply.status(500).send({ error: 'config_fetch_failed' })
    return toConfig(data)
  })

  app.put('/moderation/config', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const update: Record<string, unknown> = {}

    if (body.photoReportThreshold !== undefined) {
      if (!isNonNegativeInt(body.photoReportThreshold)) {
        return reply.status(400).send({ error: 'invalid_photo_report_threshold' })
      }
      update.photo_report_threshold = body.photoReportThreshold
    }
    if (body.reportAiMode !== undefined) {
      if (!(REPORT_AI_MODES as readonly unknown[]).includes(body.reportAiMode)) {
        return reply.status(400).send({ error: 'invalid_report_ai_mode' })
      }
      update.report_ai_mode = body.reportAiMode
    }
    if (body.reportSuspendDays !== undefined) {
      const d = body.reportSuspendDays
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) {
        return reply.status(400).send({ error: 'invalid_report_suspend_days' })
      }
      update.report_suspend_days = d
    }
    if (Object.keys(update).length === 0) {
      return reply.status(400).send({ error: 'empty_update' })
    }
    update.updated_at = new Date().toISOString()

    let data: ConfigRow | undefined
    try {
      ;[data] = await sql<ConfigRow[]>`
        update moderation_config set ${sql(update)} where id = true
        returning photo_report_threshold, report_ai_mode, report_suspend_days`
    } catch { /* falls through to config_update_failed */ }
    if (!data) return reply.status(500).send({ error: 'config_update_failed' })
    return toConfig(data)
  })
}
