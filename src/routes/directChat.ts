import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { checkAndCountDirectChat } from '../premium/directChatLimit.js'
import { seedIcebreakers } from '../icebreakers/seed.js'

// Create (or fetch the existing) match between two users without a mutual like.
// Mirrors the acceptIntro pattern: normalized pair, 23505 = already matched.
async function ensureMatch(a: string, b: string): Promise<{ matchId: string; created: boolean } | null> {
  const [u1, u2] = [a, b].sort()
  try {
    const [created] = await sql<{ id: string }[]>`
      insert into matches (user1_id, user2_id) values (${u1}, ${u2}) returning id`
    if (created) return { matchId: created.id, created: true }
    return null
  } catch (err) {
    if ((err as { code?: string })?.code !== '23505') return null
  }
  try {
    const [existing] = await sql<{ id: string }[]>`
      select id from matches where user1_id = ${u1} and user2_id = ${u2}`
    if (existing) return { matchId: existing.id, created: false }
  } catch {
    // fall through → match_failed, as before
  }
  return null
}

async function findExistingMatch(a: string, b: string): Promise<string | null> {
  const [u1, u2] = [a, b].sort()
  try {
    const [row] = await sql<{ id: string }[]>`select id from matches where user1_id = ${u1} and user2_id = ${u2}`
    return row?.id ?? null
  } catch {
    return null // read error was treated as "no match" before
  }
}

export async function directChatRoutes(app: FastifyInstance) {
  app.post('/discovery/direct-chat', {
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    if (req.isPaused) return reply.status(403).send({ error: 'account_paused' })

    const { targetUserId } = req.body as { targetUserId?: string }
    if (!targetUserId || targetUserId === req.userId) return reply.status(400).send({ error: 'invalid_target' })

    // Malformed id or failed read → "not found", as PostgREST answered.
    let target: { id: string; name: string; telegram_id: number; username: string | null; deleted_at: string | null } | undefined
    if (isUuid(targetUserId)) {
      try {
        ;[target] = await sql<NonNullable<typeof target>[]>`
          select id, name, telegram_id, username, deleted_at from users where id = ${targetUserId}`
      } catch {
        target = undefined
      }
    }
    if (!target || target.deleted_at) return reply.status(404).send({ error: 'user_not_found' })
    const found = target

    // Block in either direction. A failed read was ignored before (no rows).
    let blocked = false
    try {
      const blocks = await sql`
        select id from blocks
        where (blocker_id = ${req.userId} and blocked_id = ${targetUserId})
           or (blocker_id = ${targetUserId} and blocked_id = ${req.userId})`
      blocked = blocks.length > 0
    } catch {
      blocked = false
    }
    if (blocked) return reply.status(403).send({ error: 'blocked' })

    const buildResponse = (matchId: string, created: boolean) => ({
      created,
      match: { id: matchId, user: { id: found.id, name: found.name, telegramId: found.telegram_id, username: found.username } },
    })

    // Already matched → open the existing chat; no gate, no quota consumed.
    const existing = await findExistingMatch(req.userId, targetUserId)
    if (existing) return buildResponse(existing, false)

    const check = await checkAndCountDirectChat(req.userId)
    if (check.gate === 'paywall') return reply.status(403).send({ error: 'premium_required' })
    if (check.gate === 'quota' && check.blocked) return reply.status(403).send({ error: 'direct_chat_limit', resetAt: check.resetAt })

    const match = await ensureMatch(req.userId, targetUserId)
    if (!match) return reply.status(500).send({ error: 'match_failed' })
    if (match.created) await seedIcebreakers(match.matchId, [targetUserId, req.userId])
    // For quota users, return the post-consume window so the client keeps an
    // accurate remaining + resetAt (drives the 3/day limit sheet countdown).
    // Absent for the existing-match short-circuit above, so re-chatting the same
    // person never decrements the client's counter.
    const directChat =
      check.gate === 'quota' && !check.blocked
        ? { remaining: check.remaining, resetAt: check.resetAt }
        : undefined
    return { ...buildResponse(match.matchId, match.created), ...(directChat ? { directChat } : {}) }
  })
}
