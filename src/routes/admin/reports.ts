import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

const PAGE_SIZE = 20

function primaryPhoto(u: any): string | null {
  return (u?.user_photos ?? []).slice().sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
}

export async function adminReportsRoutes(app: FastifyInstance) {
  // Grouped pending queue (default), or a flat resolved history.
  app.get('/reports', async (req, reply) => {
    const { status = 'pending', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    if (status === 'resolved') {
      const { data, count, error } = await db
        .from('reports')
        .select(
          'id, reported_id, reason, context, status, created_at, resolved_at, ' +
          'reported:users!reports_reported_id_fkey(id, name)',
          { count: 'exact' }
        )
        .in('status', ['resolved_banned', 'dismissed'])
        .order('resolved_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)
      if (error) return reply.status(500).send({ error: 'reports_fetch_failed' })
      const total = count ?? 0
      return {
        items: (data ?? []).map((r: any) => ({
          id: r.id,
          reportedUser: { id: r.reported?.id ?? r.reported_id, name: r.reported?.name ?? '' },
          reason: r.reason, context: r.context, status: r.status,
          createdAt: r.created_at, resolvedAt: r.resolved_at,
        })),
        total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      }
    }

    // pending: query the summary view, then hydrate reported users.
    const { data: rows, count, error } = await db
      .from('pending_report_summary')
      .select('reported_id, report_count, reasons, contexts, latest_at', { count: 'exact' })
      .order('report_count', { ascending: false })
      .order('latest_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'reports_fetch_failed' })

    const ids = (rows ?? []).map((r: any) => r.reported_id)
    let usersById: Record<string, any> = {}
    if (ids.length) {
      const { data: users, error: uErr } = await db
        .from('users')
        .select('id, name, banned_at, deleted_at, user_photos(url, position)')
        .in('id', ids)
      if (uErr) return reply.status(500).send({ error: 'reports_fetch_failed' })
      usersById = Object.fromEntries((users ?? []).map((u: any) => [u.id, u]))
    }

    const total = count ?? 0
    return {
      items: (rows ?? []).map((r: any) => {
        const u = usersById[r.reported_id]
        return {
          reportedUser: {
            id: r.reported_id,
            name: u?.name ?? '',
            photo: primaryPhoto(u),
            bannedAt: u?.banned_at ?? null,
            deletedAt: u?.deleted_at ?? null,
          },
          reportCount: r.report_count,
          reasons: r.reasons ?? [],
          contexts: r.contexts ?? [],
          latestAt: r.latest_at,
        }
      }),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })

  app.get('/reports/user/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string }

    const { data: user } = await db
      .from('users')
      .select('*, user_photos(url, position)')
      .eq('id', userId)
      .single()
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    const { data: reports, error } = await db
      .from('reports')
      .select('id, reporter_id, context, reason, note, match_id, status, created_at, ' +
              'reporter:users!reports_reporter_id_fkey(id, name)')
      .eq('reported_id', userId)
      .order('status', { ascending: true })   // 'pending' sorts before 'resolved_*'/'dismissed'
      .order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: 'reports_fetch_failed' })

    const photos = (user.user_photos ?? [])
      .slice().sort((a: any, b: any) => a.position - b.position).map((p: any) => p.url)

    return {
      reportedUser: {
        id: user.id, name: user.name, age: user.age, gender: user.gender,
        bio: user.bio, username: user.username, telegramId: user.telegram_id,
        bannedAt: user.banned_at, deletedAt: user.deleted_at, photos,
      },
      reports: (reports ?? []).map((r: any) => ({
        id: r.id,
        reporterId: r.reporter_id,
        reporterName: r.reporter?.name ?? '',
        context: r.context, reason: r.reason, note: r.note,
        matchId: r.match_id, status: r.status, createdAt: r.created_at,
      })),
    }
  })

  app.post('/reports/user/:userId/resolve', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const { action } = (req.body ?? {}) as { action?: string }
    if (action !== 'ban' && action !== 'dismiss') {
      return reply.status(400).send({ error: 'invalid_action' })
    }

    const now = new Date().toISOString()
    if (action === 'ban') {
      const { error: banErr } = await db.from('users').update({ banned_at: now }).eq('id', userId)
      if (banErr) return reply.status(500).send({ error: 'resolve_failed' })
    }

    const { error: resErr } = await db
      .from('reports')
      .update({
        status: action === 'ban' ? 'resolved_banned' : 'dismissed',
        resolved_by: req.adminId,
        resolved_at: now,
      })
      .eq('reported_id', userId)
      .eq('status', 'pending')
    if (resErr) return reply.status(500).send({ error: 'resolve_failed' })

    return { ok: true }
  })
}
