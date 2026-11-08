export const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000
/** Women (and anyone who isn't a man) get at most one new-message DM per this
 * window while they stay offline — they receive many messages. Men get a DM
 * for every message while offline. */
export const NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000

export interface NotifyRecipient {
  telegram_id: number | null
  last_active: string | null
  notified_offline_at: string | null
  allows_write_to_pm: boolean | null
  /** users.locale — drives the language of the DM; null/undefined → Persian. */
  locale?: string | null
  /** users.gender — men are not throttled; everyone else is (see NOTIFY_COOLDOWN_MS). */
  gender?: string | null
}

/** Offline (last_active missing or older than the threshold) and — unless they
 * are a man — not already notified in the last NOTIFY_COOLDOWN_MS. Channel-
 * neutral: applies to push and bot DM alike. notified_offline_at is cleared
 * when the user opens the app again (server.ts), so coming back online resets. */
export function isOfflineAndCool(r: NotifyRecipient, nowMs: number): boolean {
  const isOffline = !r.last_active || nowMs - new Date(r.last_active).getTime() > OFFLINE_THRESHOLD_MS
  if (!isOffline) return false
  if (r.gender === 'man') return true
  return !r.notified_offline_at || nowMs - new Date(r.notified_offline_at).getTime() > NOTIFY_COOLDOWN_MS
}

/** The bot can DM this user: a real Telegram account (positive id — fakes have
 * negative synthetic ids, website-only users null) that has not declined PMs. */
export function canBotDm(r: Pick<NotifyRecipient, 'telegram_id' | 'allows_write_to_pm'>): boolean {
  return (r.telegram_id ?? 0) > 0 && r.allows_write_to_pm !== false
}

/** True when the recipient should receive a Telegram DM for a new message. */
export function shouldNotifyOffline(r: NotifyRecipient, nowMs: number): boolean {
  return isOfflineAndCool(r, nowMs) && canBotDm(r)
}
