import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { notifyNewMessage } from '../bot.js'

const MAX_MESSAGE_LENGTH = 2000
const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000

async function getUsableMatch(matchId: string, userId: string) {
  const { data: match } = await db
    .from('matches')
    .select(`
      id, user1_id, user2_id,
      user1:users!matches_user1_id_fkey(id, name, telegram_id, deleted_at, last_active, notified_offline_at),
      user2:users!matches_user2_id_fkey(id, name, telegram_id, deleted_at, last_active, notified_offline_at)
    `)
    .eq('id', matchId)
    .single()

  if (!match) return null
  if (match.user1_id !== userId && match.user2_id !== userId) return null

  const other: any = match.user1_id === userId ? match.user2 : match.user1
  if (other?.deleted_at) return null

  return match
}

export async function messagesRoutes(app: FastifyInstance) {
  app.get('/matches/:matchId/messages', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId } = req.params as { matchId: string }
    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const { data: rows, error } = await db
      .from('messages')
      .select('id, sender_id, body, created_at, read_at')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })

    if (error) return reply.status(500).send({ error: 'messages_fetch_failed' })

    await db
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('match_id', matchId)
      .neq('sender_id', req.userId)
      .is('read_at', null)

    return {
      messages: (rows ?? []).map((m: any) => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
    }
  })

  app.post('/matches/:matchId/messages', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId } = req.params as { matchId: string }
    const { body } = req.body as { body?: string }
    const trimmed = (body ?? '').trim()

    if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
    if (trimmed.length > MAX_MESSAGE_LENGTH) return reply.status(400).send({ error: 'message_too_long' })

    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const { data: message, error } = await db
      .from('messages')
      .insert({ match_id: matchId, sender_id: req.userId, body: trimmed })
      .select('id, sender_id, body, created_at')
      .single()

    if (error || !message) return reply.status(500).send({ error: 'send_failed' })

    const other: any = match.user1_id === req.userId ? match.user2 : match.user1
    const me: any = match.user1_id === req.userId ? match.user1 : match.user2

    const isOffline = !other.last_active || Date.now() - new Date(other.last_active).getTime() > OFFLINE_THRESHOLD_MS
    if (isOffline && !other.notified_offline_at) {
      // Mark notified_offline_at only after the Telegram send succeeds — a
      // blocked bot or API hiccup shouldn't silently consume this offline
      // stretch's one-notification allowance.
      notifyNewMessage(other.telegram_id, me.name, trimmed)
        .then(() =>
          db.from('users').update({ notified_offline_at: new Date().toISOString() }).eq('id', other.id)
        )
        .catch((err) => req.log.warn({ err }, 'failed to send offline notification'))
    }

    return {
      message: {
        id: message.id,
        senderId: message.sender_id,
        body: message.body,
        createdAt: message.created_at,
        readAt: null,
      },
    }
  })
}
