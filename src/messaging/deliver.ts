import { db } from '../db.js'
import { notifyNewMessage } from '../bot.js'
import { shouldNotifyOffline, type NotifyRecipient } from './notifyGate.js'

export type DeliveryRecipient = NotifyRecipient & { id: string }

/**
 * Send the recipient a Telegram DM for a new message, if the offline gate
 * allows it, then stamp notified_offline_at so we only DM once per offline
 * stretch. Fetches the sender's primary photo so the notification shows who
 * messaged. Never throws — a blocked bot or DB hiccup is logged and swallowed
 * so callers can fire-and-forget without affecting their response.
 */
export async function deliverMessageNotification(
  recipient: DeliveryRecipient,
  senderId: string,
  senderName: string,
  body: string,
  log?: { warn: (...a: any[]) => void },
): Promise<void> {
  try {
    if (!shouldNotifyOffline(recipient, Date.now())) return

    const { data: senderPhoto } = await db
      .from('user_photos')
      .select('url')
      .eq('user_id', senderId)
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle()

    // Stamp notified_offline_at only after the send resolves — a blocked bot
    // shouldn't consume this offline stretch's one-notification allowance.
    await notifyNewMessage(recipient.telegram_id as number, senderName, body, senderPhoto?.url ?? null)
    await db.from('users').update({ notified_offline_at: new Date().toISOString() }).eq('id', recipient.id)
  } catch (err) {
    log?.warn({ err }, 'failed to send offline notification')
  }
}
