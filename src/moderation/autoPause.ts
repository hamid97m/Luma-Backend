import { db } from '../db.js'
import { notifyFakePhotoWarning, notifyPaused } from '../bot.js'
import { deleteAllPhotosForUser } from '../photos/deleteAllPhotosForUser.js'

/** First pending fake-photo report count that is at least half the pause
 * threshold. Null when the threshold is off or too small for a halfway warning. */
export function fakePhotoWarnAt(threshold: number): number | null {
  if (threshold < 2) return null
  const at = Math.ceil(threshold / 2)
  return at < threshold ? at : null
}

/** Pending-report count that triggers an automatic photo-review pause. 0 = off. */
export async function getPhotoReportThreshold(): Promise<number> {
  const { data } = await db
    .from('moderation_config')
    .select('photo_report_threshold')
    .eq('id', true)
    .single()
  return data?.photo_report_threshold ?? 0
}

/**
 * DM once, when pending fake-photo reports hit half the pause threshold.
 * Skips anyone already paused, banned, or about to be paused on this report.
 * Never throws. Returns true only when a warning was handed to Telegram.
 */
export async function maybeWarnFakePhoto(reportedUserId: string): Promise<boolean> {
  try {
    const threshold = await getPhotoReportThreshold()
    const warnAt = fakePhotoWarnAt(threshold)
    if (warnAt == null) return false

    const { count: fakeCount } = await db
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_id', reportedUserId)
      .eq('status', 'pending')
      .eq('reason', 'fake')
    if ((fakeCount ?? 0) !== warnAt) return false

    const { count: pendingCount } = await db
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_id', reportedUserId)
      .eq('status', 'pending')
    if ((pendingCount ?? 0) >= threshold) return false

    const { data } = await db
      .from('users')
      .select('telegram_id, allows_write_to_pm, locale, gender, paused_at, banned_at')
      .eq('id', reportedUserId)
      .maybeSingle()
    if (!data || data.paused_at || data.banned_at) return false
    if (!(data.telegram_id > 0) || data.allows_write_to_pm === false) return false

    Promise.resolve(
      notifyFakePhotoWarning(data.telegram_id, data.locale ?? null, data.gender ?? null),
    ).catch((err) => console.error('[moderation] notifyFakePhotoWarning failed:', err?.message ?? err))
    return true
  } catch (err) {
    console.error('[moderation] maybeWarnFakePhoto failed:', (err as Error)?.message ?? err)
    return false
  }
}

/**
 * Auto-pause a reported user once their pending report count reaches the
 * configured threshold. Idempotent (never re-pauses an already-paused or
 * banned user) and best-effort — it swallows its own errors and returns false
 * so a report is never failed by a pause hiccup. Returns true only when this
 * call transitioned the user into the paused state.
 */
export async function maybeAutoPauseForReports(reportedUserId: string): Promise<boolean> {
  try {
    const threshold = await getPhotoReportThreshold()
    if (threshold <= 0) return false

    const { count } = await db
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_id', reportedUserId)
      .eq('status', 'pending')
    if ((count ?? 0) < threshold) return false

    // The update only matches an active, non-banned, not-already-paused row,
    // so concurrent reports can't double-pause or double-notify.
    const { data } = await db
      .from('users')
      .update({ paused_at: new Date().toISOString() })
      .eq('id', reportedUserId)
      .is('paused_at', null)
      .is('banned_at', null)
      .select('telegram_id, allows_write_to_pm, locale')
      .maybeSingle()
    if (!data) return false

    await deleteAllPhotosForUser(reportedUserId)

    // Telegram rejects DMs from bots the user never granted write access to;
    // a false flag means an explicit decline, so skip it (null = unknown, try).
    if (data.telegram_id > 0 && data.allows_write_to_pm !== false) {
      Promise.resolve(notifyPaused(data.telegram_id, data.locale ?? null)).catch((err) =>
        console.error('[moderation] notifyPaused failed:', err?.message ?? err))
    }
    return true
  } catch (err) {
    console.error('[moderation] maybeAutoPauseForReports failed:', (err as Error)?.message ?? err)
    return false
  }
}
