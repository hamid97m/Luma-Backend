import { sql } from '../db.js'
import { notifyNewMessage } from '../bot.js'
import { isOffline, isCooledDown, type NotifyRecipient } from './notifyGate.js'
import { chatHub } from '../realtime/hub.js'
import { deliverToUser, safeLinkFields } from '../notify/userNotify.js'
import type { Locale } from '../i18n/index.js'

export type DeliveryRecipient = NotifyRecipient & { id: string }

/**
 * Notify the recipient of a new message. An open SSE stream (app in the
 * foreground) suppresses everything. Otherwise push goes out right away — no
 * 10-minute wait — and the Telegram DM is the fallback only once the recipient
 * has been inactive for OFFLINE_THRESHOLD_MS (see deliverToUser). The per-gender
 * throttle applies to both; notified_offline_at is stamped when either sent. Fetches the sender's primary photo for the DM.
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
    const now = Date.now()
    if (chatHub.isConnected(recipient.id) || !isCooledDown(recipient, now)) return
    const user = { ...recipient, locale: recipient.locale ?? null }

    // Stamp notified_offline_at only after the send resolves — a blocked bot
    // shouldn't consume this offline stretch's one-notification allowance.
    const result = await deliverToUser(
      user,
      { type: 'message', title: senderName, body, ...safeLinkFields({ screen: 'matches', chat: matchId }) },
      async () => {
        const [senderPhoto] = await sql<{ url: string }[]>`
          select url from user_photos where user_id = ${senderId} order by position asc limit 1`
        await notifyNewMessage(
          recipient.telegram_id as number, senderName, body, senderPhoto?.url ?? null, matchId,
          (recipient.locale as Locale | null) ?? null,
        )
      },
      { allowBot: isOffline(recipient, now) },
    )
    if (result !== 'none') {
      await sql`update users set notified_offline_at = ${new Date().toISOString()} where id = ${recipient.id}`
    }
  } catch (err) {
    log?.warn({ err }, 'failed to send offline notification')
  }
}
