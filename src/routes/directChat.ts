import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { checkAndCountDirectChat, refundDirectChat } from '../premium/directChatLimit.js'
import { ensureMatch, insertOpener } from '../matches/ensureMatch.js'
import { deliverMessageNotification, type DeliveryRecipient } from '../messaging/deliver.js'
import {
  MAX_PENDING_REQUESTS, REQUEST_MESSAGE_MAX, announceRequest, createRequest, findRequest, waitingCount,
} from '../requests/service.js'
import { seedIcebreakers } from '../icebreakers/seed.js'
import { closeAsksOnDecision } from '../asks/service.js'

async function findExistingMatch(a: string, b: string): Promise<{ matchId: string; matchedAt: string } | null> {
  const [u1, u2] = [a, b].sort()
  try {
    const [row] = await sql<{ id: string; created_at: string }[]>`
      select id, created_at from matches where user1_id = ${u1} and user2_id = ${u2}`
    return row ? { matchId: row.id, matchedAt: row.created_at } : null
  } catch {
    return null // read error was treated as "no match" before
  }
}

interface Target extends DeliveryRecipient {
  name: string
  locale: string | null
  gender: string | null
  is_seed: boolean
}

export async function directChatRoutes(app: FastifyInstance) {
  app.post('/discovery/direct-chat', {
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    if (req.isPaused) return reply.status(403).send({ error: 'account_paused' })

    const { targetUserId, message } = req.body as { targetUserId?: string; message?: unknown }
    const opener = typeof message === 'string' ? message.trim() : ''
    if (!targetUserId || targetUserId === req.userId) return reply.status(400).send({ error: 'invalid_target' })

    // Malformed id, failed read, or a target discovery would never show
    // (deleted, banned, paused, hidden, unfinished signup) → "not found".
    let target: Target | undefined
    if (isUuid(targetUserId)) {
      try {
        ;[target] = await sql<Target[]>`
          select id, name, gender, is_seed, telegram_id, last_active, notified_offline_at,
                 allows_write_to_pm, locale
          from users
          where id = ${targetUserId}
            and deleted_at is null
            and banned_at is null
            and paused_at is null
            and is_active = true
            and account_status = 'active'
            and age > 0`
      } catch {
        target = undefined
      }
    }
    if (!target) return reply.status(404).send({ error: 'user_not_found' })
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

    const buildResponse = (m: { matchId: string; matchedAt: string }, created: boolean) => ({
      created,
      match: { id: m.matchId, matchedAt: m.matchedAt, user: { id: found.id, name: found.name } },
    })

    // Already matched → open the existing chat; no gate, no quota consumed.
    const existing = await findExistingMatch(req.userId, targetUserId)
    if (existing) {
      await closeAsksOnDecision(req.userId, targetUserId, 'messaged')
      return buildResponse(existing, false)
    }

    if (opener.length > REQUEST_MESSAGE_MAX) return reply.status(400).send({ error: 'message_too_long' })

    // A direct chat to a woman is a request she accepts or ignores. Seed
    // profiles have nobody behind them to accept, so they match right away.
    const asRequest = found.gender === 'woman' && !found.is_seed
    if (asRequest) {
      if (!opener) return reply.status(400).send({ error: 'message_required' })
      // One request per pair, ever. Pending, ignored or expired all answer the
      // same, so the sender can't tell what she did with it.
      const earlier = await findRequest(req.userId, targetUserId)
      if (earlier) return { request: { id: earlier, status: 'pending' } }
      if ((await waitingCount(req.userId)) >= MAX_PENDING_REQUESTS) {
        return reply.status(403).send({ error: 'too_many_pending' })
      }
    }

    const check = await checkAndCountDirectChat(req.userId)
    if (check.gate === 'paywall') return reply.status(403).send({ error: 'premium_required' })
    if (check.gate === 'quota' && check.blocked) return reply.status(403).send({ error: 'direct_chat_limit', resetAt: check.resetAt })

    // For quota users, return the post-consume window so the client keeps an
    // accurate remaining + resetAt (drives the 3/day limit sheet countdown).
    // Absent for the existing-match short-circuit above, so re-chatting the same
    // person never decrements the client's counter.
    const directChat =
      check.gate === 'quota' && !check.blocked
        ? { remaining: check.remaining, resetAt: check.resetAt }
        : undefined

    if (asRequest) {
      let request: { id: string; created: boolean } | null = null
      try {
        request = await createRequest(req.userId, targetUserId, opener)
      } catch (err) {
        req.log.error({ err }, 'message request insert failed')
      }
      // Nothing new was sent (double tap, or a failed write) → the slot goes back.
      if (!request?.created && check.gate === 'quota') await refundDirectChat(req.userId)
      if (!request) return reply.status(500).send({ error: 'request_failed' })
      if (!request.created) return { request: { id: request.id, status: 'pending' } }

      await closeAsksOnDecision(req.userId, targetUserId, 'messaged')
      announceRequest(request.id, req.userId, found)
      return { request: { id: request.id, status: 'pending' }, ...(directChat ? { directChat } : {}) }
    }

    const match = await ensureMatch(req.userId, targetUserId)
    if (!match) return reply.status(500).send({ error: 'match_failed' })
    if (match.created) await seedIcebreakers(match.matchId, [targetUserId, req.userId])
    if (match.created && opener) {
      try {
        await insertOpener(match.matchId, req.userId, opener)
        const [me] = await sql<{ name: string }[]>`select name from users where id = ${req.userId}`
        void deliverMessageNotification(found, req.userId, me?.name ?? '', opener, match.matchId, req.log)
      } catch (err) {
        req.log.error({ err }, 'direct chat opener failed') // the chat itself is open; they can resend
      }
    }
    // Chatting is her decision: any open "ask a friend" on this person closes.
    await closeAsksOnDecision(req.userId, targetUserId, 'messaged')
    return { ...buildResponse(match, match.created), ...(directChat ? { directChat } : {}) }
  })
}
