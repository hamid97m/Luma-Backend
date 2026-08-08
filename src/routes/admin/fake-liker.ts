import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { getFakeLikerConfig, updateFakeLikerConfig } from '../../jobs/fakeLikerConfig.js'
import { runFakeLikerJob, getNextScheduledRunAt, RunStats } from '../../jobs/fakeLiker.js'

const RUNS_PAGE_SIZE = 20

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

    const perFake = await Promise.all(
      (pool ?? []).map(async (f: any) => {
        const [{ count: likesSent }, { count: matches }] = await Promise.all([
          db.from('swipes').select('id', { count: 'exact', head: true }).eq('swiper_id', f.id).eq('direction', 'like'),
          db.from('matches').select('id', { count: 'exact', head: true }).or(`user1_id.eq.${f.id},user2_id.eq.${f.id}`),
        ])
        return { id: f.id, name: f.name, likesSent: likesSent ?? 0, matches: matches ?? 0 }
      }),
    )

    return {
      fakeWomenCount: (pool ?? []).length,
      totalLikesSent,
      totalMatchesCreated,
      totalSalamsSent,
      lastRunAt,
      nextRunAt: getNextScheduledRunAt(),
      perFake,
    }
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
