import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { checkAndCountDirectChat } from '../premium/directChatLimit.js'

// Create (or fetch the existing) match between two users without a mutual like.
// Mirrors the acceptIntro pattern: normalized pair, 23505 = already matched.
async function ensureMatch(a: string, b: string): Promise<{ matchId: string; created: boolean } | null> {
  const [u1, u2] = [a, b].sort()
  const { data: created, error: insErr } = await db
    .from('matches').insert({ user1_id: u1, user2_id: u2 }).select('id').maybeSingle()
  if (created) return { matchId: created.id, created: true }
  if (insErr?.code === '23505') {
    const { data: existing } = await db
      .from('matches').select('id').eq('user1_id', u1).eq('user2_id', u2).single()
    if (existing) return { matchId: existing.id, created: false }
  }
  return null
}

async function findExistingMatch(a: string, b: string): Promise<string | null> {
  const [u1, u2] = [a, b].sort()
  const { data } = await db.from('matches').select('id').eq('user1_id', u1).eq('user2_id', u2).maybeSingle()
  return data?.id ?? null
}

export async function directChatRoutes(app: FastifyInstance) {
  app.post('/discovery/direct-chat', {
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    if (req.isPaused) return reply.status(403).send({ error: 'account_paused' })

    const { targetUserId } = req.body as { targetUserId?: string }
    if (!targetUserId || targetUserId === req.userId) return reply.status(400).send({ error: 'invalid_target' })

    const { data: target } = await db
      .from('users').select('id, name, telegram_id, username, deleted_at').eq('id', targetUserId).single()
    if (!target || target.deleted_at) return reply.status(404).send({ error: 'user_not_found' })

    const { data: blocks } = await db
      .from('blocks').select('id')
      .or(`and(blocker_id.eq.${req.userId},blocked_id.eq.${targetUserId}),and(blocker_id.eq.${targetUserId},blocked_id.eq.${req.userId})`)
    if (blocks && blocks.length > 0) return reply.status(403).send({ error: 'blocked' })

    const buildResponse = (matchId: string, created: boolean) => ({
      created,
      match: { id: matchId, user: { id: target.id, name: target.name, telegramId: target.telegram_id, username: target.username } },
    })

    // Already matched → open the existing chat; no gate, no quota consumed.
    const existing = await findExistingMatch(req.userId, targetUserId)
    if (existing) return buildResponse(existing, false)

    const check = await checkAndCountDirectChat(req.userId)
    if (check.gate === 'paywall') return reply.status(403).send({ error: 'premium_required' })
    if (check.gate === 'quota' && check.blocked) return reply.status(403).send({ error: 'direct_chat_limit', resetAt: check.resetAt })

    const match = await ensureMatch(req.userId, targetUserId)
    if (!match) return reply.status(500).send({ error: 'match_failed' })
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
