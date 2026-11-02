import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { deliverMessageNotification } from '../messaging/deliver.js'
import { chatSendBlocked } from '../premium/chatLimit.js'

const MAX_MESSAGE_LENGTH = 2000

interface MatchParticipant {
  id: string
  name: string
  telegram_id: number
  deleted_at: string | null
  last_active: string | null
  notified_offline_at: string | null
  allows_write_to_pm: boolean | null
  gender: string | null
  locale: string | null
}

interface UsableMatch {
  id: string
  user1_id: string
  user2_id: string
  user1: MatchParticipant
  user2: MatchParticipant
}

const PARTICIPANT_COLUMNS = [
  'id', 'name', 'telegram_id', 'deleted_at', 'last_active', 'notified_offline_at',
  'allows_write_to_pm', 'gender', 'locale',
] as const

function participant(row: Record<string, any>, prefix: 'u1_' | 'u2_'): MatchParticipant {
  return Object.fromEntries(PARTICIPANT_COLUMNS.map((c) => [c, row[prefix + c]])) as unknown as MatchParticipant
}

async function getUsableMatch(matchId: string, userId: string): Promise<UsableMatch | null> {
  // A malformed id can't be a match — answer "no rows" (Postgres would throw on the cast).
  if (!isUuid(matchId)) return null

  let match: UsableMatch | undefined
  try {
    const [row] = await sql`
      select m.id, m.user1_id, m.user2_id,
        u1.id as u1_id, u1.name as u1_name, u1.telegram_id as u1_telegram_id, u1.deleted_at as u1_deleted_at,
        u1.last_active as u1_last_active, u1.notified_offline_at as u1_notified_offline_at,
        u1.allows_write_to_pm as u1_allows_write_to_pm, u1.gender as u1_gender, u1.locale as u1_locale,
        u2.id as u2_id, u2.name as u2_name, u2.telegram_id as u2_telegram_id, u2.deleted_at as u2_deleted_at,
        u2.last_active as u2_last_active, u2.notified_offline_at as u2_notified_offline_at,
        u2.allows_write_to_pm as u2_allows_write_to_pm, u2.gender as u2_gender, u2.locale as u2_locale
      from matches m
      join users u1 on u1.id = m.user1_id
      join users u2 on u2.id = m.user2_id
      where m.id = ${matchId}`
    if (row) {
      match = {
        id: row.id, user1_id: row.user1_id, user2_id: row.user2_id,
        user1: participant(row, 'u1_'), user2: participant(row, 'u2_'),
      }
    }
  } catch {
    return null // read failure was "not found" before
  }

  if (!match) return null
  if (match.user1_id !== userId && match.user2_id !== userId) return null

  const other = match.user1_id === userId ? match.user2 : match.user1
  if (other?.deleted_at) return null

  // A block in either direction ends the conversation for both sides. The match
  // list already hides blocked pairs, but a stale/open client could still hit
  // these endpoints — enforce it server-side so a blocked user can't keep
  // sending or reading messages.
  try {
    const [block] = await sql`
      select id from blocks
      where (blocker_id = ${userId} and blocked_id = ${other.id})
         or (blocker_id = ${other.id} and blocked_id = ${userId})
      limit 1`
    if (block) return null
  } catch {
    // Ignored before (maybeSingle error → no block row) — keep failing open.
  }

  return match
}

export async function messagesRoutes(app: FastifyInstance) {
  app.get('/matches/:matchId/messages', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { matchId } = req.params as { matchId: string }
    const match = await getUsableMatch(matchId, req.userId)
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    // Embedded gift (left join): null for non-gift rows, else { gift_emoji, gift_star_cost }.
    let rows: any[]
    try {
      rows = await sql`
        select m.id, m.sender_id, m.body, m.icebreaker_answer, m.created_at, m.read_at, m.edited_at,
          m.reply_to_message_id, m.type, m.gift_transaction_id,
          case when g.id is null then null
               else json_build_object('gift_emoji', g.gift_emoji, 'gift_star_cost', g.gift_star_cost)
          end as gift
        from messages m
        left join gift_transactions g on g.id = m.gift_transaction_id
        where m.match_id = ${matchId}
        order by m.created_at asc`
    } catch (err) {
      req.log.error({ err }, 'messages fetch failed')
      return reply.status(500).send({ error: 'messages_fetch_failed' })
    }

    // Best-effort read receipt — a failure here never failed the fetch.
    try {
      await sql`
        update messages set read_at = ${new Date().toISOString()}
        where match_id = ${matchId} and sender_id <> ${req.userId} and read_at is null`
    } catch (err) {
      req.log.warn({ err }, 'mark messages read failed')
    }

    return {
      messages: rows.map((m: any) => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        type: m.type ?? 'text',
        icebreakerAnswer: m.icebreaker_answer ?? null,
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

    // Free men and women whose preference includes women may chat with 2 distinct
    // people for free; starting a 3rd conversation requires premium. Continuing any of their existing chats,
    // women, premium members, and everyone while the toggle is off are unaffected.
    if (await chatSendBlocked(req.userId, matchId)) {
      return reply.status(403).send({ error: 'premium_required' })
    }

    if (replyToMessageId) {
      // Malformed or failed lookup → no parent (treated as "no rows").
      let parent: unknown
      if (isUuid(replyToMessageId)) {
        try {
          ;[parent] = await sql`select id from messages where id = ${replyToMessageId} and match_id = ${matchId}`
        } catch {
          parent = undefined
        }
      }
      if (!parent) return reply.status(400).send({ error: 'invalid_reply_target' })
    }

    let message: any
    try {
      ;[message] = await sql`
        insert into messages (match_id, sender_id, body, reply_to_message_id)
        values (${matchId}, ${req.userId}, ${trimmed}, ${replyToMessageId ?? null})
        returning id, sender_id, body, created_at, reply_to_message_id`
    } catch (err) {
      req.log.error({ err }, 'message insert failed')
      return reply.status(500).send({ error: 'send_failed' })
    }
    if (!message) return reply.status(500).send({ error: 'send_failed' })

    const other = match.user1_id === req.userId ? match.user2 : match.user1
    const me = match.user1_id === req.userId ? match.user1 : match.user2

    void deliverMessageNotification(
      { id: other.id, telegram_id: other.telegram_id, last_active: other.last_active, notified_offline_at: other.notified_offline_at, allows_write_to_pm: other.allows_write_to_pm, locale: other.locale ?? null },
      req.userId,
      me.name,
      trimmed,
      matchId,
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
    // match a row, so there is no fetch-then-check race. Only text is
    // editable; gift and icebreaker rows fall through to 404.
    // A malformed message id can't match a row → 404.
    if (!isUuid(messageId)) return reply.status(404).send({ error: 'message_not_found' })

    let message: any
    try {
      ;[message] = await sql`
        update messages set body = ${trimmed}, edited_at = ${new Date().toISOString()}
        where id = ${messageId} and match_id = ${matchId} and sender_id = ${req.userId} and type = 'text'
        returning id, sender_id, body, created_at, read_at, edited_at, reply_to_message_id`
    } catch (err) {
      req.log.error({ err }, 'message edit failed')
      return reply.status(500).send({ error: 'edit_failed' })
    }
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

    if (!isUuid(messageId)) return reply.status(404).send({ error: 'message_not_found' })

    let deleted: readonly unknown[]
    try {
      deleted = await sql`
        delete from messages
        where id = ${messageId} and match_id = ${matchId} and sender_id = ${req.userId}
        returning id`
    } catch (err) {
      req.log.error({ err }, 'message delete failed')
      return reply.status(500).send({ error: 'delete_failed' })
    }
    if (deleted.length === 0) return reply.status(404).send({ error: 'message_not_found' })

    return { ok: true }
  })
}
