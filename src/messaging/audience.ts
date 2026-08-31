const DAY_MS = 86_400_000

export interface BroadcastFilters {
  genders?: string[]
  lookingFor?: string[]
  activity?: { activeWithinDays?: number; inactiveOverDays?: number }
  premium?: 'premium' | 'free'
}

export interface BroadcastTarget {
  id: string
  telegram_id: number
}

/** Apply baseline guards + optional targeting filters to a Supabase users query. */
export function applyAudienceFilters(query: any, filters: BroadcastFilters, nowMs = Date.now()): any {
  // Baseline: real, active, opted-in users only.
  query = query
    .eq('is_seed', false)
    .is('banned_at', null)
    .is('deleted_at', null)
    .gt('telegram_id', 0)
    // opted-in = column is null OR true (only an explicit false opts out).
    .or('allows_write_to_pm.is.null,allows_write_to_pm.eq.true')

  if (filters.genders?.length) query = query.in('gender', filters.genders)
  if (filters.lookingFor?.length) query = query.in('looking_for', filters.lookingFor)

  const activeWithin = filters.activity?.activeWithinDays
  if (activeWithin != null) {
    query = query.gte('last_active', new Date(nowMs - activeWithin * DAY_MS).toISOString())
  }
  const inactiveOver = filters.activity?.inactiveOverDays
  if (inactiveOver != null) {
    query = query.lt('last_active', new Date(nowMs - inactiveOver * DAY_MS).toISOString())
  }

  if (filters.premium === 'premium') {
    query = query.gt('premium_until', new Date(nowMs).toISOString())
  } else if (filters.premium === 'free') {
    query = query.or(`premium_until.is.null,premium_until.lte.${new Date(nowMs).toISOString()}`)
  }

  return query
}

/** Count how many users match the filters (for the preview endpoint). */
export async function countAudience(dbClient: any, filters: BroadcastFilters, nowMs = Date.now()): Promise<number> {
  const query = applyAudienceFilters(
    dbClient.from('users').select('id', { count: 'exact', head: true }),
    filters,
    nowMs,
  )
  const { count } = await query
  return count ?? 0
}

/** Fetch all matching users' id + telegram_id, paginating past Supabase's 1000-row cap. */
export async function fetchAudience(dbClient: any, filters: BroadcastFilters, nowMs = Date.now()): Promise<BroadcastTarget[]> {
  const PAGE = 1000
  const out: BroadcastTarget[] = []
  for (let from = 0; ; from += PAGE) {
    const query = applyAudienceFilters(
      dbClient.from('users').select('id, telegram_id'),
      filters,
      nowMs,
    ).range(from, from + PAGE - 1)
    const { data, error } = await query
    if (error) throw error
    if (!data?.length) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}
