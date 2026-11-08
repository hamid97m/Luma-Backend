import { sql } from '../db.js'
import { isLocale } from '../i18n/index.js'
import type { ClientPlatform } from '../devices/clientInfo.js'

const DAY_MS = 86_400_000

export interface BroadcastFilters {
  genders?: string[]
  lookingFor?: string[]
  activity?: { activeWithinDays?: number; inactiveOverDays?: number }
  premium?: 'premium' | 'free'
  /** `users.locale` values ('fa' | 'en' | 'ar'); unknown values are dropped, absent/empty = no filter. */
  locales?: string[]
  /** Has a device of one of these platforms seen in the last 90 days. */
  platforms?: ClientPlatform[]
}

export type BroadcastChannel = 'bot' | 'push'

export interface PushTarget {
  id: string
  tokens: string[]
}

export interface BroadcastTarget {
  id: string
  telegram_id: number
}

/** Baseline guards + optional targeting filters, as a `where` clause over `users`. */
export function audienceWhere(filters: BroadcastFilters, channel: BroadcastChannel = 'bot', nowMs = Date.now()) {
  const f = filters ?? {}
  const nowIso = new Date(nowMs).toISOString()
  const activeWithin = f.activity?.activeWithinDays
  const inactiveOver = f.activity?.inactiveOverDays

  return sql`
    where is_seed = false
      and banned_at is null
      and deleted_at is null
      ${channel === 'bot' ? sql`
      and telegram_id > 0
      -- opted-in = column is null OR true (only an explicit false opts out).
      and (allows_write_to_pm is null or allows_write_to_pm = true)` : sql`
      and exists (select 1 from user_devices t where t.user_id = users.id and t.push_token is not null)`}
      ${f.platforms?.length ? sql`and exists (select 1 from user_devices d where d.user_id = users.id
          and d.platform = any(${f.platforms}::text[])
          and d.last_seen_at > now() - interval '90 days')` : sql``}
      ${f.genders?.length ? sql`and gender::text = any(${f.genders}::text[])` : sql``}
      ${f.lookingFor?.length ? sql`and looking_for::text = any(${f.lookingFor}::text[])` : sql``}
      ${
        // Fail closed: once the admin asked for a locale filter, an all-invalid
        // list must match nobody (empty array), never fall back to everyone.
        f.locales?.length ? sql`and locale = any(${f.locales.filter(isLocale)}::text[])` : sql``
      }
      ${activeWithin != null
        ? sql`and last_active >= ${new Date(nowMs - activeWithin * DAY_MS).toISOString()}` : sql``}
      ${inactiveOver != null
        ? sql`and last_active < ${new Date(nowMs - inactiveOver * DAY_MS).toISOString()}` : sql``}
      ${f.premium === 'premium' ? sql`and premium_until > ${nowIso}`
        : f.premium === 'free' ? sql`and (premium_until is null or premium_until <= ${nowIso})`
        : sql``}`
}

/** Count how many users match the filters (for the preview endpoint). */
export async function countAudience(
  filters: BroadcastFilters, channel: BroadcastChannel = 'bot', nowMs = Date.now(),
): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from users ${audienceWhere(filters, channel, nowMs)}`
  return count
}

/** Fetch all matching users' id + telegram_id (bot channel). */
export async function fetchAudience(
  filters: BroadcastFilters, _channel: 'bot' = 'bot', nowMs = Date.now(),
): Promise<BroadcastTarget[]> {
  return sql<BroadcastTarget[]>`
    select id, telegram_id from users ${audienceWhere(filters, 'bot', nowMs)}
    order by id asc`
}

/** Push channel: one row per user with all of their push tokens. */
export async function fetchPushAudience(
  filters: BroadcastFilters, nowMs = Date.now(),
): Promise<PushTarget[]> {
  return sql<PushTarget[]>`
    select users.id, array_agg(pt.push_token order by pt.id) as tokens
    from users
    join user_devices pt on pt.user_id = users.id and pt.push_token is not null
    ${audienceWhere(filters, 'push', nowMs)}
    group by users.id
    order by users.id asc`
}
