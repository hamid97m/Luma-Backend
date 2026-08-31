import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { maybeAutoPauseForReports } from '../moderation/autoPause.js'

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

    const { data: reported } = await db.from('users').select('id').eq('id', reportedUserId).single()
    if (!reported) return reply.status(404).send({ error: 'user_not_found' })

    // Only trust matchId if the reporter actually participates in that match.
    let matchId: string | null = null
    if (context === 'chat' && rawMatchId) {
      const { data: match } = await db
        .from('matches')
        .select('user1_id, user2_id')
        .eq('id', rawMatchId)
        .single()
      if (match && (match.user1_id === req.userId || match.user2_id === req.userId)) {
        matchId = rawMatchId
      }
    }

    const { error: insertErr } = await db.from('reports').insert({
      reporter_id: req.userId,
      reported_id: reportedUserId,
      context,
      reason,
      note,
      match_id: matchId,
      status: 'pending',
    })
    // 23505 = unique_violation on the pending index → already reported, treat as success.
    if (insertErr && insertErr.code !== '23505') {
      req.log.error({ err: insertErr }, 'report insert failed')
      return reply.status(500).send({ error: 'report_failed' })
    }

    // Auto-hide: reporter blocks reported. Ignore duplicates.
    await db.from('blocks').upsert(
      { blocker_id: req.userId, blocked_id: reportedUserId },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    )

    // Auto-pause the reported user for photo re-verification once they cross
    // the admin-set report threshold. Best-effort — never fails the report.
    await maybeAutoPauseForReports(reportedUserId)

    return { ok: true }
  })
}
