export const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000
/** New-message bot DM (the fallback when no push was delivered): at most one
 * per (recipient, chat) per this window, unless the recipient was active
 * since the last one. Pushes are not throttled. */
export const CHAT_NOTIFY_WINDOW_MS = 10 * 60 * 1000

export interface NotifyRecipient {
  telegram_id: number | null
  last_active: string | null
  /** Stamped when a new-message notification goes out (cleared on return to
   * the app); delivery no longer reads it. */
  notified_offline_at: string | null
  allows_write_to_pm: boolean | null
  /** users.locale — drives the language of the DM; null/undefined → Persian. */
  locale?: string | null
  gender?: string | null
}

/** Offline: last_active missing or older than OFFLINE_THRESHOLD_MS. */
export function isOffline(r: Pick<NotifyRecipient, 'last_active'>, nowMs: number): boolean {
  return !r.last_active || nowMs - new Date(r.last_active).getTime() > OFFLINE_THRESHOLD_MS
}

/** The bot can DM this user: a real Telegram account (positive id — fakes have
 * negative synthetic ids, website-only users null) that has not declined PMs. */
export function canBotDm(r: Pick<NotifyRecipient, 'telegram_id' | 'allows_write_to_pm'>): boolean {
  return (r.telegram_id ?? 0) > 0 && r.allows_write_to_pm !== false
}
