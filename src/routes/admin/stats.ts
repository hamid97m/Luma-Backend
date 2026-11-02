import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { sql } from '../../db.js'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function startOfTodayIso(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

// `where` is a trusted fragment (``sql`where …` ``); values inside it are bind parameters.
async function count(table: string, where = sql``): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} ${where}`
  return n
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
        count('users', sql`where deleted_at is null`),
        count('users', sql`where banned_at is not null`),
        count('users', sql`where deleted_at is not null`),
        count('users', sql`where is_seed = true`),
        count('users', sql`where created_at >= ${today}`),
        count('users', sql`where created_at >= ${daysAgoIso(7)}`),
        count('users', sql`where deleted_at is null and last_active >= ${daysAgoIso(1)}`),
        count('users', sql`where deleted_at is null and last_active >= ${daysAgoIso(7)}`),
        count('users', sql`where deleted_at is null and gender = 'man'`),
        count('users', sql`where deleted_at is null and gender = 'woman'`),
        count('users', sql`where deleted_at is null and gender = 'nonbinary'`),
        count('matches'),
        count('matches', sql`where created_at >= ${today}`),
        count('messages', sql`where type <> 'icebreaker'`),
        count('messages', sql`where type <> 'icebreaker' and created_at >= ${today}`),
        count('swipes'),
        count('swipes', sql`where direction = 'like'`),
        sql<{ created_at: string }[]>`select created_at from users where created_at >= ${monthAgo}`,
        sql<{ created_at: string }[]>`select created_at from matches where created_at >= ${monthAgo}`,
        count('users', sql`where premium_until > ${new Date().toISOString()}`),
        sql<{ price_stars: number }[]>`
          select price_stars from premium_transactions where status = 'paid' and source = 'purchase'`,
        sql<{ user_id: string; paid_at: string }[]>`
          select user_id, paid_at from premium_transactions
          where status = 'paid' and paid_at is not null
          order by paid_at asc`,
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
