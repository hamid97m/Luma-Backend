import { sql } from '../db.js'
import { notifyFakePhotoWarning, notifyPaused } from '../bot.js'
import { deleteAllPhotosForUser } from '../photos/deleteAllPhotosForUser.js'
import type { Locale } from '../i18n/locale.js'

/** First pending fake-photo report count that is at least half the pause
 * threshold. Null when the threshold is off or too small for a halfway warning. */
export function fakePhotoWarnAt(threshold: number): number | null {
  if (threshold < 2) return null
  const at = Math.ceil(threshold / 2)
  return at < threshold ? at : null
}

/** Pending-report count that triggers an automatic photo-review pause. 0 = off. */
export async function getPhotoReportThreshold(): Promise<number> {
  // A failed read means "off" (0), as before.
  const [data] = await sql<{ photo_report_threshold: number }[]>`
    select photo_report_threshold from moderation_config where id = true`.catch(() => [])
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

    const [{ count: fakeCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from reports
      where reported_id = ${reportedUserId} and status = 'pending' and reason = 'fake'`
    if (fakeCount !== warnAt) return false

    const [{ count: pendingCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from reports
      where reported_id = ${reportedUserId} and status = 'pending'`
    if (pendingCount >= threshold) return false

    const [data] = await sql<{
      telegram_id: number; allows_write_to_pm: boolean | null; locale: Locale | null
      gender: string | null; paused_at: string | null; banned_at: string | null
    }[]>`
      select telegram_id, allows_write_to_pm, locale, gender, paused_at, banned_at
      from users where id = ${reportedUserId}`
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

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from reports
      where reported_id = ${reportedUserId} and status = 'pending'`
    if (count < threshold) return false

    return await pauseForPhotoReview(reportedUserId)
  } catch (err) {
    console.error('[moderation] maybeAutoPauseForReports failed:', (err as Error)?.message ?? err)
    return false
  }
}

/**
 * Hide a user from discovery until they upload a fresh photo: pause, delete
 * every photo, and DM them. Returns true only when this call transitioned the
 * user into the paused state.
 */
export async function pauseForPhotoReview(userId: string): Promise<boolean> {
  // The update only matches an active, non-banned, not-already-paused row,
  // so concurrent callers can't double-pause or double-notify.
  // A failed write reads as "not paused" (false), as with supabase-js.
  const [data] = await sql<{ telegram_id: number; allows_write_to_pm: boolean | null; locale: Locale | null }[]>`
    update users set paused_at = ${new Date().toISOString()}
    where id = ${userId} and paused_at is null and banned_at is null
    returning telegram_id, allows_write_to_pm, locale`.catch((err) => {
      console.error('[moderation] pauseForPhotoReview update failed:', (err as Error)?.message ?? err)
      return []
    })
  if (!data) return false

  await deleteAllPhotosForUser(userId)

  // Telegram rejects DMs from bots the user never granted write access to;
  // a false flag means an explicit decline, so skip it (null = unknown, try).
  if (data.telegram_id > 0 && data.allows_write_to_pm !== false) {
    Promise.resolve(notifyPaused(data.telegram_id, data.locale ?? null)).catch((err) =>
      console.error('[moderation] notifyPaused failed:', err?.message ?? err))
  }
  return true
}
