import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../../db.js'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function startOfTodayIso(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

async function count(table: string, refine?: (q: any) => any): Promise<number> {
  let q: any = db.from(table).select('id', { count: 'exact', head: true })
  if (refine) q = refine(q)
  const { count: n, error } = await q
  if (error) throw new Error(`stats count failed: ${table}`)
  return n ?? 0
}

function bucketPerDay(rows: { created_at: string }[], days: number): { date: string; count: number }[] {
  const buckets = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10), 0)
  }
  for (const row of rows) {
    const key = row.created_at.slice(0, 10)
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return Array.from(buckets.entries()).map(([date, n]) => ({ date, count: n }))
}

export async function adminStatsRoutes(app: FastifyInstance) {
  app.get('/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const today = startOfTodayIso()
      const monthAgo = daysAgoIso(30)

      const [
        users, banned, deleted, seed,
        newToday, newWeek, dau, wau,
        men, women, nonbinary,
        matches, matchesToday, messages, messagesToday,
        swipes, likes,
        signupRows, matchRows,
        premiumActive, premiumRevenueRows, premiumPaidRows,
      ] = await Promise.all([
        count('users', (q) => q.is('deleted_at', null)),
        count('users', (q) => q.not('banned_at', 'is', null)),
        count('users', (q) => q.not('deleted_at', 'is', null)),
        count('users', (q) => q.eq('is_seed', true)),
        count('users', (q) => q.gte('created_at', today)),
        count('users', (q) => q.gte('created_at', daysAgoIso(7))),
        count('users', (q) => q.is('deleted_at', null).gte('last_active', daysAgoIso(1))),
        count('users', (q) => q.is('deleted_at', null).gte('last_active', daysAgoIso(7))),
        count('users', (q) => q.is('deleted_at', null).eq('gender', 'man')),
        count('users', (q) => q.is('deleted_at', null).eq('gender', 'woman')),
        count('users', (q) => q.is('deleted_at', null).eq('gender', 'nonbinary')),
        count('matches'),
        count('matches', (q) => q.gte('created_at', today)),
        count('messages'),
        count('messages', (q) => q.gte('created_at', today)),
        count('swipes'),
        count('swipes', (q) => q.eq('direction', 'like')),
        db.from('users').select('created_at').gte('created_at', monthAgo)
          .then(({ data, error }: any) => { if (error) throw new Error('stats rows failed'); return data ?? [] }),
        db.from('matches').select('created_at').gte('created_at', monthAgo)
          .then(({ data, error }: any) => { if (error) throw new Error('stats rows failed'); return data ?? [] }),
        count('users', (q) => q.gt('premium_until', new Date().toISOString())),
        db.from('premium_transactions').select('price_stars').eq('status', 'paid').eq('source', 'purchase')
          .then(({ data, error }: any) => { if (error) throw new Error('stats rows failed'); return data ?? [] }),
        db.from('premium_transactions').select('user_id, paid_at').eq('status', 'paid').not('paid_at', 'is', null)
          .order('paid_at', { ascending: true })
          .then(({ data, error }: any) => { if (error) throw new Error('stats rows failed'); return data ?? [] }),
      ])

      // First paid tx per user = the day they became premium for the first time.
      const seen = new Set<string>()
      const firstActivations: { created_at: string }[] = []
      for (const row of premiumPaidRows as { user_id: string; paid_at: string }[]) {
        if (seen.has(row.user_id)) continue
        seen.add(row.user_id)
        firstActivations.push({ created_at: row.paid_at })
      }

      return {
        totals: {
          users, matches, messages, swipes,
          likeRate: swipes > 0 ? likes / swipes : 0,
          banned, deleted, seed,
        },
        today: { newUsers: newToday, matches: matchesToday, messages: messagesToday },
        week: { newUsers: newWeek },
        dau, wau,
        genders: { man: men, woman: women, nonbinary },
        signupsPerDay: bucketPerDay(signupRows, 30),
        matchesPerDay: bucketPerDay(matchRows, 30),
        premium: {
          activeUsers: premiumActive,
          revenueStars: (premiumRevenueRows as { price_stars: number }[]).reduce((s, r) => s + r.price_stars, 0),
          newPremiumPerDay: bucketPerDay(firstActivations, 30),
        },
      }
    } catch (err) {
      req.log.error({ err }, 'stats fetch failed')
      return reply.status(500).send({ error: 'stats_fetch_failed' })
    }
  })
}
