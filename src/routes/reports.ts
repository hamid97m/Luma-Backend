import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { maybeAutoPauseForReports, maybeWarnFakePhoto } from '../moderation/autoPause.js'

const REASONS = ['fake', 'inappropriate', 'harassment', 'spam', 'other'] as const
const CONTEXTS = ['discovery', 'chat'] as const
type Reason = (typeof REASONS)[number]
type Context = (typeof CONTEXTS)[number]

export async function reportsRoutes(app: FastifyInstance) {
  app.post('/reports', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const reportedUserId = typeof body.reportedUserId === 'string' ? body.reportedUserId : ''
    const context = body.context as Context
    const reason = body.reason as Reason
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null
    const rawMatchId = typeof body.matchId === 'string' ? body.matchId : null

    if (!reportedUserId) return reply.status(400).send({ error: 'invalid_report' })
    if (reportedUserId === req.userId) return reply.status(400).send({ error: 'cannot_report_self' })
    if (!CONTEXTS.includes(context) || !REASONS.includes(reason)) {
      return reply.status(400).send({ error: 'invalid_report' })
    }

    // Malformed id or failed read → "not found".
    let reported: { id: string; deleted_at: string | null } | undefined
    if (isUuid(reportedUserId)) {
      try {
        ;[reported] = await sql<{ id: string; deleted_at: string | null }[]>`
          select id, deleted_at from users where id = ${reportedUserId}`
      } catch {
        reported = undefined
      }
    }
    if (!reported || reported.deleted_at) return reply.status(404).send({ error: 'user_not_found' })

    // Only trust matchId if the reporter actually participates in that match.
    let matchId: string | null = null
    if (context === 'chat' && rawMatchId && isUuid(rawMatchId)) {
      try {
        const [match] = await sql<{ user1_id: string; user2_id: string }[]>`
          select user1_id, user2_id from matches where id = ${rawMatchId}`
        if (match && (match.user1_id === req.userId || match.user2_id === req.userId)) {
          matchId = rawMatchId
        }
      } catch {
        // unreadable match → store null, as before
      }
    }

    let duplicate = false
    try {
      await sql`
        insert into reports (reporter_id, reported_id, context, reason, note, match_id, status)
        values (${req.userId}, ${reportedUserId}, ${context}, ${reason}, ${note}, ${matchId}, 'pending')`
    } catch (err) {
      // 23505 = unique_violation on the pending index → already reported, treat as success.
      if ((err as { code?: string })?.code !== '23505') {
        req.log.error({ err }, 'report insert failed')
        return reply.status(500).send({ error: 'report_failed' })
      }
      duplicate = true
    }

    // Auto-hide: reporter blocks reported. Ignore duplicates; a failure here
    // never failed the report.
    try {
      await sql`
        insert into blocks (blocker_id, blocked_id) values (${req.userId}, ${reportedUserId})
        on conflict (blocker_id, blocked_id) do nothing`
    } catch (err) {
      req.log.warn({ err }, 'report auto-block failed')
    }

    // A new fake-photo report may be the one that crosses half the pause
    // threshold. Best-effort — never fails the report. Skipped on a duplicate
    // pending report so the warning is not sent again.
    if (!duplicate && reason === 'fake') {
      await maybeWarnFakePhoto(reportedUserId)
    }

    // Auto-pause the reported user for photo re-verification once they cross
    // the admin-set report threshold. Best-effort — never fails the report.
    await maybeAutoPauseForReports(reportedUserId)

    return { ok: true }
  })
}
