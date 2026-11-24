import { sql } from '../db.js'
import { isPremiumActive } from '../premium/service.js'
import { getReferralConfig } from '../referrals/config.js'
import { notifyUserLikesUnlocked } from '../notify/userNotify.js'

/** Days of "see everyone who liked you" a woman gets per woman friend who joins. */
export const LIKES_DAYS_PER_FRIEND = 7

// The main-photo check runs in the background after signup; give it this long
// before counting a friend without its answer (e.g. the checker is down).
const PHOTO_CHECK_GRACE = '10 minutes'

export interface LikesAccess {
  /** A real woman: her likes come one a day unless unlocked. */
  daily: boolean
  /** Sees her whole queue (invite unlock or active premium). */
  unlocked: boolean
  /** The invite unlock, while it is in the future. */
  unlockedUntil: string | null
}

/** Throws on a read error: callers must not mistake it for "unlocked". */
export async function getLikesAccess(userId: string, nowMs = Date.now()): Promise<LikesAccess> {
  const [u] = await sql<{
    gender: string; is_seed: boolean | null; premium_until: string | null; likes_unlocked_until: string | null
  }[]>`
    select gender, is_seed, premium_until, likes_unlocked_until from users where id = ${userId}`
  const daily = !!u && u.gender === 'woman' && !u.is_seed
  if (!u || !daily) return { daily: false, unlocked: false, unlockedUntil: null }
  const until = u.likes_unlocked_until
  const unlockedUntil = until && new Date(until).getTime() > nowMs ? new Date(until).toISOString() : null
  return { daily, unlocked: unlockedUntil !== null || isPremiumActive(u.premium_until ?? null, nowMs), unlockedUntil }
}

/**
 * Pays a woman referrer 7 days per woman friend who joined and was not paid yet.
 * One statement: the claim (likes_rewarded_at) and the extension land together,
 * so a race or a crash can neither double-pay nor lose a friend.
 * Safe to call any time (catch-up); never throws.
 */
export async function grantFriendLikeDays(referrerId: string): Promise<void> {
  try {
    if (!(await getReferralConfig())?.enabled) return
    const checksOn = Boolean(process.env.DEEPSEEK_API_KEY) && process.env.PHOTO_AI_CHECK !== 'off'
    const [row] = await sql<{
      id: string; telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null; friends: number
    }[]>`
      with paid as (
        update referrals r set likes_rewarded_at = now()
        from users f
        where r.referrer_id = ${referrerId}
          and r.qualified_at is not null
          and r.likes_rewarded_at is null
          and f.id = r.referred_id
          and f.gender = 'woman' and not coalesce(f.is_seed, false)
          and f.deleted_at is null and f.banned_at is null and f.paused_at is null
          and (f.suspended_until is null or f.suspended_until <= now())
          and exists (
            select 1 from users me
            where me.id = ${referrerId} and me.gender = 'woman' and me.deleted_at is null and me.banned_at is null)
          -- Her current main photo must not look like a man's (unless an admin
          -- cleared that flag); wait a little for the check to answer.
          and exists (select 1 from user_photos p where p.user_id = f.id)
          and not exists (
            select 1 from (
              select p.id, p.created_at from user_photos p where p.user_id = f.id order by p.position asc limit 1
            ) mp
            left join photo_ai_checks pc on pc.photo_id = mp.id
            where pc.approved = false
               or (pc.apparent_gender = 'man'
                   and pc.created_at > coalesce(f.gender_review_dismissed_at, '-infinity'::timestamptz))
               or (${checksOn} and pc.photo_id is null
                   and greatest(r.qualified_at, mp.created_at) > now() - ${PHOTO_CHECK_GRACE}::interval))
        returning r.referred_id
      ), n as (select count(*)::int as friends from paid)
      update users u
      set likes_unlocked_until =
        greatest(now(), coalesce(u.likes_unlocked_until, now())) + make_interval(days => n.friends * ${LIKES_DAYS_PER_FRIEND}::int)
      from n
      where u.id = ${referrerId} and n.friends > 0
      returning u.id, u.telegram_id, u.allows_write_to_pm, u.locale, n.friends`
    if (!row) return
    // Not awaited: GET /likes runs this as a catch-up and must not wait on Telegram.
    notifyUserLikesUnlocked(row, row.friends * LIKES_DAYS_PER_FRIEND)
      .catch((err) => console.error('likes-unlocked notify failed', err))
  } catch (err) {
    console.error('grantFriendLikeDays failed', err)
  }
}

/** The friend's main-photo check just answered: pay whoever invited her. */
export async function grantAfterPhotoCheck(friendId: string): Promise<void> {
  try {
    const [r] = await sql<{ referrer_id: string }[]>`
      select referrer_id from referrals
      where referred_id = ${friendId} and qualified_at is not null and likes_rewarded_at is null`
    if (r) await grantFriendLikeDays(r.referrer_id)
  } catch (err) {
    console.error('grantAfterPhotoCheck failed', err)
  }
}

/** What her invite sheet shows; null for anyone but a woman. */
export async function likesRewardStatus(userId: string) {
  const access = await getLikesAccess(userId).catch(() => null)
  if (!access?.daily) return null
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from referrals
    where referrer_id = ${userId} and likes_rewarded_at is not null`.catch(() => [{ count: 0 }])
  return { daysPerFriend: LIKES_DAYS_PER_FRIEND, friendsCounted: count, unlockedUntil: access.unlockedUntil }
}
