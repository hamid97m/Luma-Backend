import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

export async function adminModerationRoutes(app: FastifyInstance) {
  app.get('/moderation/config', async (_req, reply) => {
    const { data, error } = await db
      .from('moderation_config')
      .select('photo_report_threshold')
      .eq('id', true)
      .single()
    if (error || !data) return reply.status(500).send({ error: 'config_fetch_failed' })
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

    const { data, error } = await db
      .from('moderation_config')
      .update(update)
      .eq('id', true)
      .select('photo_report_threshold')
      .single()
    if (error || !data) return reply.status(500).send({ error: 'config_update_failed' })
    return { photoReportThreshold: data.photo_report_threshold }
  })
}
