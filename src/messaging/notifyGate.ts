export const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000

export interface NotifyRecipient {
  telegram_id: number | null
  last_active: string | null
  notified_offline_at: string | null
  allows_write_to_pm: boolean | null
}

/**
 * True when the recipient should receive a one-shot Telegram DM: they are
 * offline (last_active missing or older than the threshold), have not already
 * been notified this offline stretch, have not declined PMs, and are a real
 * user (positive telegram_id — fakes have negative synthetic ids).
 */
export function shouldNotifyOffline(r: NotifyRecipient, nowMs: number): boolean {
  const isOffline = !r.last_active || nowMs - new Date(r.last_active).getTime() > OFFLINE_THRESHOLD_MS
  return (
    isOffline &&
    !r.notified_offline_at &&
    r.allows_write_to_pm !== false &&
    (r.telegram_id ?? 0) > 0
  )
}
