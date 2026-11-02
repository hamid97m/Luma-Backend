import { sql } from '../db.js'

/** One chat message as the client sees it — an item of GET /matches/:id/messages
 *  and the `message` of the realtime `message` / `message_updated` events. */
export interface MessageJson {
  id: string
  senderId: string
  body: string | null
  type: string
  icebreakerAnswer: string | null
  gift: { emoji: string | null; starCost: number } | null
  createdAt: string
  readAt: string | null
  editedAt: string | null
  replyToMessageId: string | null
}

/** Select list matching messageJson(); `m` = messages, `g` = left-joined gift_transactions.
 *  A fresh fragment per call (postgres.js fragments belong to one query). */
export function messageColumns() {
  // Embedded gift (left join): null for non-gift rows, else { gift_emoji, gift_star_cost }.
  return sql`
    m.id, m.match_id, m.sender_id, m.body, m.icebreaker_answer, m.created_at, m.read_at, m.edited_at,
    m.reply_to_message_id, m.type, m.gift_transaction_id,
    case when g.id is null then null
         else json_build_object('gift_emoji', g.gift_emoji, 'gift_star_cost', g.gift_star_cost)
    end as gift`
}

export function messageJson(m: Record<string, any>): MessageJson {
  return {
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
  }
}

/** Messages of one match by id (any order; missing ids are simply absent). */
export async function loadMessagesByIds(matchId: string, ids: string[]): Promise<MessageJson[]> {
  if (ids.length === 0) return []
  const rows = await sql`
    select ${messageColumns()}
    from messages m
    left join gift_transactions g on g.id = m.gift_transaction_id
    where m.match_id = ${matchId} and m.id in ${sql(ids)}
    order by m.created_at asc, m.id asc`
  return rows.map(messageJson)
}
