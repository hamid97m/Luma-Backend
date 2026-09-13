import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { getFakeLikerConfig, updateFakeLikerConfig } from '../../jobs/fakeLikerConfig.js'
import { runFakeLikerJob, getNextScheduledRunAt, RunStats } from '../../jobs/fakeLiker.js'

const RUNS_PAGE_SIZE = 20
const FAKES_PAGE_SIZE = 20

function isValidMaxTargets(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000
}

export async function adminFakeLikerRoutes(app: FastifyInstance) {
  app.get('/fake-liker/config', async (_req, reply) => {
    const cfg = await getFakeLikerConfig()
    if (!cfg) return reply.status(500).send({ error: 'config_fetch_failed' })
    return cfg
  })

  app.put('/fake-liker/config', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: { enabled?: boolean; maxTargetsPerRun?: number } = {}

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return reply.status(400).send({ error: 'invalid_enabled' })
      patch.enabled = body.enabled
    }
    if (body.maxTargetsPerRun !== undefined) {
      if (!isValidMaxTargets(body.maxTargetsPerRun)) return reply.status(400).send({ error: 'invalid_max_targets_per_run' })
      patch.maxTargetsPerRun = body.maxTargetsPerRun
    }

    const cfg = await updateFakeLikerConfig(patch)
    if (!cfg) return reply.status(500).send({ error: 'config_update_failed' })
    return cfg
  })

  app.post('/fake-liker/run', async (_req, reply) => {
    const result = await runFakeLikerJob('manual', app.log)
    if ('skipped' in result && typeof (result as { skipped: unknown }).skipped === 'string') {
      const reason = (result as { skipped: string }).skipped
      if (reason === 'disabled') return reply.status(403).send({ ok: false, error: 'disabled' })
      if (reason === 'already_running') return reply.status(409).send({ ok: false, error: 'already_running' })
      // Unknown skip reason — surface it rather than silently mapping to a wrong status.
      return reply.status(500).send({ ok: false, error: reason })
    }
    return { ok: true, stats: result as RunStats }
  })

  app.get('/fake-liker/stats', async (_req, reply) => {
    // Fake pool: same filter used by the job itself (active, non-banned women seeds).
    const { data: pool, error: poolErr } = await db
      .from('users')
      .select('id, name')
      .eq('is_seed', true)
      .eq('gender', 'woman')
      .eq('is_active', true)
      .is('banned_at', null)
      .is('deleted_at', null)
    if (poolErr) return reply.status(500).send({ error: 'stats_fetch_failed' })

    // Aggregated server-side (not fetched-and-summed client-side): fake_liker_runs
    // grows unbounded over time and an unordered unbounded `select` would silently
    // truncate at PostgREST's max-rows cap, corrupting totals/lastRunAt once the
    // table outgrows it.
    const { data: totalsRow, error: totalsErr } = await db.rpc('fake_liker_run_totals').single()
    if (totalsErr) return reply.status(500).send({ error: 'stats_fetch_failed' })

    const totals = (totalsRow ?? {}) as {
      total_likes_sent: number | string
      total_matches_created: number | string
      total_salams_sent: number | string
      last_run_at: string | null
    }
    const totalLikesSent = Number(totals.total_likes_sent ?? 0)
    const totalMatchesCreated = Number(totals.total_matches_created ?? 0)
    const totalSalamsSent = Number(totals.total_salams_sent ?? 0)
    const lastRunAt = totals.last_run_at ?? null

    return {
      fakeWomenCount: (pool ?? []).length,
      totalLikesSent,
      totalMatchesCreated,
      totalSalamsSent,
      lastRunAt,
      nextRunAt: getNextScheduledRunAt(),
    }
  })

  app.get('/fake-liker/fakes', async (req, reply) => {
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)

    // Fake pool: same filter used by the job itself (active, non-banned women seeds).
    const { data: pool, error: poolErr } = await db
      .from('users')
      .select('id, name')
      .eq('is_seed', true)
      .eq('gender', 'woman')
      .eq('is_active', true)
      .is('banned_at', null)
      .is('deleted_at', null)
    if (poolErr) return reply.status(500).send({ error: 'fakes_fetch_failed' })

    const poolIds = (pool ?? []).map((f: any) => f.id)
    if (poolIds.length === 0) return { items: [], total: 0, page: pageNum, pageCount: 1 }
    const poolIdSet = new Set(poolIds)

    // One bulk fetch of every match touching the pool, instead of a per-fake count query.
    const { data: matches, error: matchesErr } = await db
      .from('matches')
      .select('id, user1_id, user2_id')
      .or(`user1_id.in.(${poolIds.join(',')}),user2_id.in.(${poolIds.join(',')})`)
    if (matchesErr) return reply.status(500).send({ error: 'fakes_fetch_failed' })

    const matchesByFake = new Map<string, number>()
    const realByMatch = new Map<string, string>() // matchId -> real (non-fake) participant id
    const fakeByMatch = new Map<string, string>() // matchId -> pool participant id
    for (const m of matches ?? []) {
      const u1Fake = poolIdSet.has(m.user1_id)
      const u2Fake = poolIdSet.has(m.user2_id)
      if (u1Fake) matchesByFake.set(m.user1_id, (matchesByFake.get(m.user1_id) ?? 0) + 1)
      if (u2Fake) matchesByFake.set(m.user2_id, (matchesByFake.get(m.user2_id) ?? 0) + 1)
      if (u1Fake && u2Fake) continue // both fake -> no real recipient for unread purposes
      realByMatch.set(m.id, u1Fake ? m.user2_id : m.user1_id)
      fakeByMatch.set(m.id, u1Fake ? m.user1_id : m.user2_id)
    }

    // One bulk fetch of unread messages across every match with a real recipient.
    const unreadByFake = new Map<string, Set<string>>()
    if (realByMatch.size > 0) {
      const { data: unread, error: unreadErr } = await db
        .from('messages')
        .select('match_id, sender_id')
        .is('read_at', null)
        .in('match_id', [...realByMatch.keys()])
      if (unreadErr) return reply.status(500).send({ error: 'fakes_fetch_failed' })

      for (const msg of unread ?? []) {
        if (realByMatch.get(msg.match_id) === msg.sender_id) {
          const fakeId = fakeByMatch.get(msg.match_id)
          if (!fakeId) continue
          if (!unreadByFake.has(fakeId)) unreadByFake.set(fakeId, new Set())
          unreadByFake.get(fakeId)!.add(msg.match_id)
        }
      }
    }

    const withUnread = (pool ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      unreadCount: unreadByFake.get(f.id)?.size ?? 0,
    }))
    withUnread.sort((a, b) => b.unreadCount - a.unreadCount || a.name.localeCompare(b.name))

    const total = withUnread.length
    const pageCount = Math.max(1, Math.ceil(total / FAKES_PAGE_SIZE))
    const from = (pageNum - 1) * FAKES_PAGE_SIZE
    const pageFakes = withUnread.slice(from, from + FAKES_PAGE_SIZE)

    const items = await Promise.all(
      pageFakes.map(async (f) => {
        const { count: likesSent } = await db
          .from('swipes')
          .select('id', { count: 'exact', head: true })
          .eq('swiper_id', f.id)
          .eq('direction', 'like')
        return {
          id: f.id,
          name: f.name,
          likesSent: likesSent ?? 0,
          matches: matchesByFake.get(f.id) ?? 0,
          unreadCount: f.unreadCount,
        }
      }),
    )

    return { items, total, page: pageNum, pageCount }
  })

  app.get('/fake-liker/runs', async (req, reply) => {
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * RUNS_PAGE_SIZE

    const { data, count, error } = await db
      .from('fake_liker_runs')
      .select('id, trigger, started_at, finished_at, likes_sent, matches_created, salams_sent, errors', { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(from, from + RUNS_PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'runs_fetch_failed' })

    const total = count ?? 0
    return {
      items: (data ?? []).map((r: any) => ({
        id: r.id,
        trigger: r.trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        likesSent: r.likes_sent,
        matchesCreated: r.matches_created,
        salamsSent: r.salams_sent,
        errors: r.errors,
      })),
      total,
      page: pageNum,
      pageCount: Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE)),
    }
  })
}
