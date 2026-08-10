import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { premiumGateBlocks } from '../premium/service.js'
import { deliverMessageNotification } from '../messaging/deliver.js'

const MAX_MESSAGE_LENGTH = 2000

async function getUsableMatch(matchId: string, userId: string) {
  const { data: match } = await db
    .from('matches')
    .select(`
      id, user1_id, user2_id,
      user1:users!matches_user1_id_fkey(id, name, telegram_id, deleted_at, last_active, notified_offline_at, allows_write_to_pm, gender),
      user2:users!matches_user2_id_fkey(id, name, telegram_id, deleted_at, last_active, notified_offline_at, allows_write_to_pm, gender)
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
      .select('id, sender_id, body, created_at, read_at, edited_at, reply_to_message_id, type, gift_transaction_id, gift:gift_transactions!messages_gift_transaction_id_fkey(gift_emoji, gift_star_cost)')
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
        type: m.type ?? 'text',
        gift: m.gift ? { emoji: m.gift.gift_emoji ?? null, starCost: m.gift.gift_star_cost } : null,
        createdAt: m.created_at,
        readAt: m.read_at,
        editedAt: m.edited_at ?? null,
        replyToMessageId: m.reply_to_message_id ?? null,
      })),
    }
  })

  app.post('/matches/:matchId/messages', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId } = req.params as { matchId: string }
    const { body, replyToMessageId } = req.body as { body?: string; replyToMessageId?: string }
    const trimmed = (body ?? '').trim()

    if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
    if (trimmed.length > MAX_MESSAGE_LENGTH) return reply.status(400).send({ error: 'message_too_long' })

    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const partner: any = match.user1_id === req.userId ? match.user2 : match.user1
    if (await premiumGateBlocks(req.userId, partner?.gender ?? null)) {
      return reply.status(403).send({ error: 'premium_required' })
    }

    if (replyToMessageId) {
      const { data: parent } = await db
        .from('messages')
        .select('id')
        .eq('id', replyToMessageId)
        .eq('match_id', matchId)
        .maybeSingle()
      if (!parent) return reply.status(400).send({ error: 'invalid_reply_target' })
    }

    const { data: message, error } = await db
      .from('messages')
      .insert({ match_id: matchId, sender_id: req.userId, body: trimmed, reply_to_message_id: replyToMessageId ?? null })
      .select('id, sender_id, body, created_at, reply_to_message_id')
      .single()

    if (error || !message) return reply.status(500).send({ error: 'send_failed' })

    const other: any = match.user1_id === req.userId ? match.user2 : match.user1
    const me: any = match.user1_id === req.userId ? match.user1 : match.user2

    void deliverMessageNotification(
      { id: other.id, telegram_id: other.telegram_id, last_active: other.last_active, notified_offline_at: other.notified_offline_at, allows_write_to_pm: other.allows_write_to_pm },
      req.userId,
      me.name,
      trimmed,
      req.log,
    )

    return {
      message: {
        id: message.id,
        senderId: message.sender_id,
        body: message.body,
        createdAt: message.created_at,
        readAt: null,
        editedAt: null,
        replyToMessageId: message.reply_to_message_id ?? null,
      },
    }
  })

  app.patch('/matches/:matchId/messages/:messageId', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId, messageId } = req.params as { matchId: string; messageId: string }
    const { body } = req.body as { body?: string }
    const trimmed = (body ?? '').trim()

    if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
    if (trimmed.length > MAX_MESSAGE_LENGTH) return reply.status(400).send({ error: 'message_too_long' })

    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    // Ownership is enforced atomically by the filter — a non-sender can never
    // match a row, so there is no fetch-then-check race.
    const { data: message, error } = await db
      .from('messages')
      .update({ body: trimmed, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('match_id', matchId)
      .eq('sender_id', req.userId)
      .select('id, sender_id, body, created_at, read_at, edited_at, reply_to_message_id')
      .maybeSingle()

    if (error) return reply.status(500).send({ error: 'edit_failed' })
    if (!message) return reply.status(404).send({ error: 'message_not_found' })

    return {
      message: {
        id: message.id,
        senderId: message.sender_id,
        body: message.body,
        createdAt: message.created_at,
        readAt: message.read_at,
        editedAt: message.edited_at,
        replyToMessageId: message.reply_to_message_id ?? null,
      },
    }
  })

  app.delete('/matches/:matchId/messages/:messageId', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId, messageId } = req.params as { matchId: string; messageId: string }
    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const { data: deleted, error } = await db
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('match_id', matchId)
      .eq('sender_id', req.userId)
      .select('id')

    if (error) return reply.status(500).send({ error: 'delete_failed' })
    if (!deleted || deleted.length === 0) return reply.status(404).send({ error: 'message_not_found' })

    return { ok: true }
  })
}
