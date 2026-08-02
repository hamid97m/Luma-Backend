import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

const MAX_MESSAGE_LENGTH = 2000

async function getUsableMatch(matchId: string, userId: string) {
  const { data: match } = await db
    .from('matches')
    .select(`
      id, user1_id, user2_id,
      user1:users!matches_user1_id_fkey(id, deleted_at),
      user2:users!matches_user2_id_fkey(id, deleted_at)
    `)
    .eq('id', matchId)
    .single()

  if (!match) return null
  if (match.user1_id !== userId && match.user2_id !== userId) return null

  const other = match.user1_id === userId ? match.user2 : match.user1
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
      .select('id, sender_id, body, created_at')
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

    return {
      message: {
        id: message.id,
        senderId: message.sender_id,
        body: message.body,
        createdAt: message.created_at,
      },
    }
  })
}
