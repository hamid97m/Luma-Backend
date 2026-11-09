import { sql } from '../db.js'
import { notifyNewMessage } from '../bot.js'
import { CHAT_NOTIFY_WINDOW_MS, type NotifyRecipient } from './notifyGate.js'
import { chatHub } from '../realtime/hub.js'
import { deliverToUser, safeLinkFields } from '../notify/userNotify.js'
import { isPushConfigured } from '../push/fcm.js'
import { isStandby } from '../appMode.js'
import type { Locale } from '../i18n/index.js'

export type DeliveryRecipient = NotifyRecipient & { id: string }

/**
 * Race-safe claim of the bot-DM slot for (recipient, chat): at most one DM per
 * CHAT_NOTIFY_WINDOW_MS, unless the recipient was active after the last one.
 * Gate check + claim row run under an advisory lock in one short transaction
 * (no network calls inside), so two messages arriving together can't both
 * pass. Also prunes this user's rows older than 2 days. Returns the claim id,
 * or null when the slot is taken.
 */
async function claimBotSlot(recipient: DeliveryRecipient, matchId: string): Promise<number | null> {
  const lastActive = recipient.last_active ?? null
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${recipient.id}), hashtext(${matchId}))`
    const [held] = await tx`
      select 1 from message_notifications
      where user_id = ${recipient.id} and match_id = ${matchId} and channel = 'bot'
        and sent_at > now() - make_interval(secs => ${CHAT_NOTIFY_WINDOW_MS / 1000})
        and (${lastActive}::timestamptz is null or ${lastActive}::timestamptz <= sent_at)
      limit 1`
    if (held) return null
    await tx`delete from message_notifications where user_id = ${recipient.id} and sent_at < now() - interval '2 days'`
    const [row] = await tx<{ id: number }[]>`
      insert into message_notifications (user_id, match_id, channel)
      values (${recipient.id}, ${matchId}, 'bot') returning id`
    return row.id
  }) as Promise<number | null>
}

/** Unread messages from the other participant in this chat — the same
 * definition as the chat-list badge (routes/matches.ts unread_count). */
async function unreadCount(recipientId: string, matchId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from messages
    where match_id = ${matchId} and sender_id <> ${recipientId} and read_at is null`
  return row?.n ?? 0
}

/**
 * Notify the recipient of a new message unless they are online — the same
 * "online" as the in-app green dot (chatHub.isOnline: an open SSE stream, or
 * closed less than PRESENCE_GRACE_MS ago). Telegram-style:
 *   - push for every message, any gender, tagged per chat (fcm.ts) and
 *     carrying the chat's unread count;
 *   - bot DM only when no push was delivered, at most one per chat per
 *     CHAT_NOTIFY_WINDOW_MS unless the recipient was active since the last one
 *     (claimBotSlot; message_notifications).
 * notified_offline_at is stamped when either went out (other code reads it).
 * Never throws — a blocked bot or DB hiccup is logged and swallowed so callers
 * can fire-and-forget without affecting their response.
 */
export async function deliverMessageNotification(
  recipient: DeliveryRecipient,
  senderId: string,
  senderName: string,
  body: string,
  matchId: string,
  log?: { warn: (...a: any[]) => void },
): Promise<void> {
  try {
    if (chatHub.isOnline(recipient.id)) return
    const user = { ...recipient, locale: recipient.locale ?? null }
    const unread = isPushConfigured() && !isStandby() ? await unreadCount(recipient.id, matchId) : 0

    let held = false
    const result = await deliverToUser(
      user,
      {
        type: 'message', title: senderName, body,
        ...safeLinkFields({ screen: 'matches', chat: matchId }),
        ...(unread > 0 ? { unread: String(unread) } : {}),
      },
      async () => {
        const claimId = await claimBotSlot(recipient, matchId)
        if (claimId === null) { held = true; return }
        try {
          const [senderPhoto] = await sql<{ url: string }[]>`
            select url from user_photos where user_id = ${senderId} order by position asc limit 1`
          await notifyNewMessage(
            recipient.telegram_id as number, senderName, body, senderPhoto?.url ?? null, matchId,
            (recipient.locale as Locale | null) ?? null,
          )
        } catch (err) {
          // Nothing went out: release the slot so the next message can try.
          await sql`delete from message_notifications where id = ${claimId}`.catch(() => {})
          throw err
        }
      },
    )
    // Stamp only after a send resolved — a blocked bot sends nothing.
    if (result !== 'none' && !held) {
      await sql`update users set notified_offline_at = ${new Date().toISOString()} where id = ${recipient.id}`
    }
  } catch (err) {
    log?.warn({ err }, 'failed to send offline notification')
  }
}
