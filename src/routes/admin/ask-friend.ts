import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { sql } from '../../db.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 7
// Asks and events are purged 30 days after closing / recording.
const MAX_DAYS = 30

function parseDays(raw: unknown): number {
  const days = Number.parseInt(String(raw), 10)
  return Number.isNaN(days) ? DEFAULT_DAYS : Math.min(MAX_DAYS, Math.max(1, days))
}

/** "Ask a friend" numbers for the dashboard. Counted from the ask tables (events
 *  can be sent by clients), except the steps before an ask exists. Asks about
 *  someone who deleted their account are gone, so they aren't counted. */
export async function adminAskFriendRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>('/ask-friend', async (req: FastifyRequest<{ Querystring: { days?: string } }>, reply: FastifyReply) => {
    const days = parseDays(req.query.days)
    const since = new Date(Date.now() - days * DAY_MS).toISOString()

    try {
      const [[asks], byQuestion, outcomes, recipients, verdicts, entry, [signups], [friends], perDay] = await Promise.all([
        sql<{ total: number; women: number; answered: number; median_hours: number | null }[]>`
          select count(*)::int as total, count(distinct r.requester_id)::int as women,
                 count(f.first_at)::int as answered,
                 (percentile_cont(0.5) within group (order by extract(epoch from f.first_at - r.created_at) / 3600))::float8 as median_hours
          from ask_requests r
          left join lateral (select min(ar.answered_at) as first_at from ask_recipients ar where ar.request_id = r.id) f on true
          where r.created_at >= ${since}`,
        sql<{ question: string; count: number }[]>`
          select question, count(*)::int as count from ask_requests where created_at >= ${since} group by 1 order by 2 desc, 1`,
        // Still open past its 48h (the job runs every 15 min) already counts as expired.
        sql<{ outcome: string; count: number }[]>`
          select case when status = 'open' and expires_at > now() then 'open'
                      when status = 'open' then 'expired'
                      else coalesce(closed_reason, status) end as outcome, count(*)::int as count
          from ask_requests where created_at >= ${since} group by 1 order by 2 desc, 1`,
        sql<{ kind: 'member' | 'link'; sent: number; viewed: number; answered: number; notes: number }[]>`
          select ar.kind, count(*)::int as sent, count(ar.seen_at)::int as viewed, count(ar.answered_at)::int as answered,
                 count(ar.note)::int as notes
          from ask_recipients ar join ask_requests r on r.id = ar.request_id
          where r.created_at >= ${since} group by 1`,
        sql<{ verdict: string; count: number }[]>`
          select ar.verdict, count(*)::int as count
          from ask_recipients ar join ask_requests r on r.id = ar.request_id
          where r.created_at >= ${since} and ar.verdict is not null group by 1`,
        sql<{ name: string; women: number }[]>`
          select name, count(distinct user_id)::int as women from ask_events
          where created_at >= ${since} and user_id is not null and name in ('ask_tooltip_shown', 'ask_entry_tap')
          group by 1`,
        // Recorded by the server only, once per new account.
        sql<{ n: number }[]>`
          select count(distinct user_id)::int as n from ask_events where name = 'advisor_converted' and created_at >= ${since}`,
        sql<{ active: number; removed: number }[]>`
          select (count(*) filter (where removed_at is null))::int as active,
                 (count(*) filter (where removed_at is not null))::int as removed
          from ask_friends`,
        sql<{ date: string; asks: number; answers: number }[]>`
          select to_char(d, 'YYYY-MM-DD') as date,
                 (select count(*) from ask_requests r
                  where r.created_at >= d at time zone 'UTC' and r.created_at < (d + interval '1 day') at time zone 'UTC')::int as asks,
                 (select count(*) from ask_recipients ar
                  where ar.answered_at >= d at time zone 'UTC' and ar.answered_at < (d + interval '1 day') at time zone 'UTC')::int as answers
          from generate_series((now() at time zone 'UTC')::date - ${days - 1}::int, (now() at time zone 'UTC')::date, interval '1 day') d
          order by d`,
      ])

      const kind = (k: 'member' | 'link') => {
        const r = recipients.find((x) => x.kind === k)
        return { sent: r?.sent ?? 0, viewed: r?.viewed ?? 0, answered: r?.answered ?? 0 }
      }
      const verdict = (v: string) => verdicts.find((x) => x.verdict === v)?.count ?? 0
      const step = (n: string) => entry.find((x) => x.name === n)?.women ?? 0

      return {
        days,
        entry: { sawTip: step('ask_tooltip_shown'), tapped: step('ask_entry_tap'), asked: asks.women },
        asks: { total: asks.total, women: asks.women, withAnswer: asks.answered, medianHoursToFirstAnswer: asks.median_hours },
        byQuestion,
        outcomes,
        friends: { member: kind('member'), link: kind('link') },
        verdicts: { yes: verdict('yes'), unsure: verdict('unsure'), no: verdict('no') },
        notes: recipients.reduce((n, r) => n + r.notes, 0),
        signups: signups.n,
        friendships: friends,
        perDay,
      }
    } catch (err) {
      req.log.error({ err }, 'ask-friend stats fetch failed')
      return reply.status(500).send({ error: 'ask_friend_stats_failed' })
    }
  })
}
