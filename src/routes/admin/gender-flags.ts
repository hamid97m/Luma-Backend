import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
import { countGenderFlags, listGenderFlags } from '../../moderation/genderFlags.js'

const PAGE_SIZE = 30

export async function adminGenderFlagsRoutes(app: FastifyInstance) {
  app.get('/gender-flags/count', async (req, reply) => {
    try {
      return { count: await countGenderFlags() }
    } catch (err) {
      req.log.error({ err }, 'gender flags count failed')
      return reply.status(500).send({ error: 'gender_flags_fetch_failed' })
    }
  })

  app.get('/gender-flags', async (req, reply) => {
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    try {
      const [rows, total] = await Promise.all([
        listGenderFlags(PAGE_SIZE, (pageNum - 1) * PAGE_SIZE),
        countGenderFlags(),
      ])
      return {
        items: rows.map((r) => ({
          user: {
            id: r.id, name: r.name, gender: r.gender, age: r.age, photoUrl: r.photo_url ?? null,
            bannedAt: r.banned_at ?? null, pausedAt: r.paused_at ?? null,
          },
          photoGender: r.photo_gender ?? null,
          nameGender: r.name_gender ?? null,
          checkedAt: r.checked_at,
        })),
        total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      }
    } catch (err) {
      req.log.error({ err }, 'gender flags fetch failed')
      return reply.status(500).send({ error: 'gender_flags_fetch_failed' })
    }
  })

  app.post('/gender-flags/:userId/dismiss', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    let row: { id: string } | undefined
    try {
      ;[row] = isUuid(userId)
        ? await sql<{ id: string }[]>`update users set gender_review_dismissed_at = now() where id = ${userId} returning id`
        : []
    } catch (err) {
      req.log.error({ err }, 'gender flag dismiss failed')
      return reply.status(500).send({ error: 'dismiss_failed' })
    }
    if (!row) return reply.status(404).send({ error: 'user_not_found' })
    return { ok: true }
  })
}
