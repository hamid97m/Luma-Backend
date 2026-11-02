import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'

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
      let data: any[]
      let total: number
      try {
        const [rows, [{ count }]] = await Promise.all([
          sql`
            select r.id, r.reported_id, r.reason, r.context, r.status, r.created_at, r.resolved_at,
                   u.id as reported_user_id, u.name as reported_name
            from reports r
            left join users u on u.id = r.reported_id
            where r.status in ('resolved_banned', 'dismissed')
            order by r.resolved_at desc
            limit ${PAGE_SIZE} offset ${from}`,
          sql<{ count: number }[]>`
            select count(*)::int as count from reports where status in ('resolved_banned', 'dismissed')`,
        ])
        data = rows
        total = count
      } catch (err) {
        req.log.error({ err }, 'reports fetch failed')
        return reply.status(500).send({ error: 'reports_fetch_failed' })
      }
      return {
        items: data.map((r: any) => ({
          id: r.id,
          reportedUser: { id: r.reported_user_id ?? r.reported_id, name: r.reported_name ?? '' },
          reason: r.reason, context: r.context, status: r.status,
          createdAt: r.created_at, resolvedAt: r.resolved_at,
        })),
        total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      }
    }

    // pending: query the summary view, then hydrate reported users.
    let rows: any[]
    let total: number
    let usersById: Record<string, any> = {}
    try {
      const [summary, [{ count }]] = await Promise.all([
        // Enum arrays cast to text[] so they arrive as plain string arrays.
        sql`
          select reported_id, report_count, reasons::text[] as reasons, contexts::text[] as contexts, latest_at
          from pending_report_summary
          order by report_count desc, latest_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from pending_report_summary`,
      ])
      rows = summary
      total = count

      const ids = rows.map((r: any) => r.reported_id)
      if (ids.length) {
        const users = await sql`
          select u.id, u.name, u.banned_at, u.deleted_at,
                 coalesce((select json_agg(json_build_object('url', p.url, 'position', p.position))
                           from user_photos p where p.user_id = u.id), '[]') as user_photos
          from users u where u.id = any(${ids}::uuid[])`
        usersById = Object.fromEntries(users.map((u: any) => [u.id, u]))
      }
    } catch (err) {
      req.log.error({ err }, 'reports fetch failed')
      return reply.status(500).send({ error: 'reports_fetch_failed' })
    }

    return {
      items: rows.map((r: any) => {
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

    // Malformed id or a failed lookup → 404, as PostgREST's `data: null` did.
    let user: any
    try {
      ;[user] = isUuid(userId)
        ? await sql`
            select u.*,
                   coalesce((select json_agg(json_build_object('url', p.url, 'position', p.position))
                             from user_photos p where p.user_id = u.id), '[]') as user_photos
            from users u where u.id = ${userId}`
        : []
    } catch (err) {
      req.log.error({ err }, 'reported user lookup failed')
    }
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    let reports: any[]
    try {
      reports = await sql`
        select r.id, r.reporter_id, r.context, r.reason, r.note, r.match_id, r.status, r.created_at,
               rep.name as reporter_name
        from reports r
        left join users rep on rep.id = r.reporter_id
        where r.reported_id = ${userId}
        order by r.status asc, r.created_at desc` // enum order: 'pending' sorts first
    } catch (err) {
      req.log.error({ err }, 'reports fetch failed')
      return reply.status(500).send({ error: 'reports_fetch_failed' })
    }

    const photos = (user.user_photos ?? [])
      .slice().sort((a: any, b: any) => a.position - b.position).map((p: any) => p.url)

    return {
      reportedUser: {
        id: user.id, name: user.name, age: user.age, gender: user.gender,
        bio: user.bio, username: user.username, telegramId: user.telegram_id,
        bannedAt: user.banned_at, deletedAt: user.deleted_at, photos,
      },
      reports: reports.map((r: any) => ({
        id: r.id,
        reporterId: r.reporter_id,
        reporterName: r.reporter_name ?? '',
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

    // A malformed id matches no user and no reports: nothing to do (PostgREST "no rows").
    if (!isUuid(userId)) return { ok: true }

    const now = new Date().toISOString()
    try {
      // Ban + resolve together, so a failed resolve no longer leaves a half-done ban.
      await sql.begin(async (tx) => {
        if (action === 'ban') await tx`update users set banned_at = ${now} where id = ${userId}`
        await tx`
          update reports
          set status = ${action === 'ban' ? 'resolved_banned' : 'dismissed'},
              resolved_by = ${req.adminId ?? null},
              resolved_at = ${now}
          where reported_id = ${userId} and status = 'pending'`
      })
    } catch (err) {
      req.log.error({ err }, 'report resolve failed')
      return reply.status(500).send({ error: 'resolve_failed' })
    }

    return { ok: true }
  })
}
