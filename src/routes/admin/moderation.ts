import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

export async function adminModerationRoutes(app: FastifyInstance) {
  app.get('/moderation/config', async (_req, reply) => {
    let data: { photo_report_threshold: number } | undefined
    try {
      ;[data] = await sql<{ photo_report_threshold: number }[]>`
        select photo_report_threshold from moderation_config where id = true`
    } catch { /* falls through to config_fetch_failed */ }
    if (!data) return reply.status(500).send({ error: 'config_fetch_failed' })
    return { photoReportThreshold: data.photo_report_threshold }
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
    if (Object.keys(update).length === 0) {
      return reply.status(400).send({ error: 'empty_update' })
    }
    update.updated_at = new Date().toISOString()

    let data: { photo_report_threshold: number } | undefined
    try {
      ;[data] = await sql<{ photo_report_threshold: number }[]>`
        update moderation_config set ${sql(update)} where id = true
        returning photo_report_threshold`
    } catch { /* falls through to config_update_failed */ }
    if (!data) return reply.status(500).send({ error: 'config_update_failed' })
    return { photoReportThreshold: data.photo_report_threshold }
  })
}
