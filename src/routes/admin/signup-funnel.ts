import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { sql } from '../../db.js'
import { SIGNUP_STEPS } from '../signupEvents.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 7
const MAX_DAYS = 90

// Natural flow order. Failures have their own list; page_hidden is not a funnel stage.
const FUNNEL_EVENTS = [
  'app_open', 'auth_ok', 'auth_failed', 'login_view', 'picker_view', 'picker_done',
  'step_view', 'photo_pick', 'photo_ok', 'submit_ok',
]
const FAILURE_EVENTS = ['auth_failed', 'photo_failed', 'submit_failed']

function parseDays(raw: unknown): number {
  const days = Number.parseInt(String(raw), 10)
  return Number.isNaN(days) ? DEFAULT_DAYS : Math.min(MAX_DAYS, Math.max(1, days))
}

const stepRank = (step: string | null) => SIGNUP_STEPS.indexOf(step ?? '')

export async function adminSignupFunnelRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>('/signup-funnel', async (req: FastifyRequest<{ Querystring: { days?: string } }>, reply: FastifyReply) => {
    const days = parseDays(req.query.days)
    const since = new Date(Date.now() - days * DAY_MS).toISOString()

    try {
      const [funnel, failures, lastStep] = await Promise.all([
        sql<{ name: string; step: string | null; sessions: number }[]>`
          select name, step, count(distinct session_id)::int as sessions
          from signup_events
          where created_at >= ${since} and name in ${sql(FUNNEL_EVENTS)}
          group by name, step`,
        sql<{ name: string; detail: string | null; count: number }[]>`
          select name, detail, count(*)::int as count
          from signup_events
          where created_at >= ${since} and name in ${sql(FAILURE_EVENTS)}
          group by name, detail
          order by count desc, name, detail`,
        // id breaks ties: events sent in one batch share created_at.
        sql<{ step: string; sessions: number }[]>`
          select step, count(*)::int as sessions
          from (
            select distinct on (session_id)
              session_id, coalesce(step, 'picker') as step
            from signup_events
            where created_at >= ${since}
              and (name = 'picker_view' or (name = 'step_view' and step is not null))
            order by session_id, created_at desc, id desc
          ) as latest
          where not exists (
            select 1 from signup_events done
            where done.session_id = latest.session_id and done.name = 'submit_ok'
          )
          group by step`,
      ])

      return {
        days,
        funnel: [...funnel].sort((a, b) =>
          FUNNEL_EVENTS.indexOf(a.name) - FUNNEL_EVENTS.indexOf(b.name) || stepRank(a.step) - stepRank(b.step)),
        failures,
        lastStep: [...lastStep].sort((a, b) => stepRank(a.step) - stepRank(b.step)),
      }
    } catch (err) {
      req.log.error({ err }, 'signup funnel fetch failed')
      return reply.status(500).send({ error: 'signup_funnel_fetch_failed' })
    }
  })
}
