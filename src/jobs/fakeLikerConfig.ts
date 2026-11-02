import { sql } from '../db.js'

export interface FakeLikerConfig {
  enabled: boolean
  maxTargetsPerRun: number
}

/** Reads the fake_liker_config singleton. Never throws: a missing table/row or
 * any query error is treated as "not configured" — callers (job, routes) fall
 * back to a default/disabled state on null. */
export async function getFakeLikerConfig(): Promise<FakeLikerConfig | null> {
  try {
    const [data] = await sql<{ enabled: boolean; max_targets_per_run: number }[]>`
      select enabled, max_targets_per_run from fake_liker_config where id = true`
    if (!data) return null
    return { enabled: data.enabled, maxTargetsPerRun: data.max_targets_per_run }
  } catch {
    return null
  }
}

/** Timestamp (ISO) of the most recent fake-liker run of any trigger, or null if
 * there are none / the query fails. Used at startup to resume the 6h cadence
 * across restarts instead of re-firing shortly after every deploy. */
export async function getLastFakeLikerRunAt(): Promise<string | null> {
  try {
    const [data] = await sql<{ started_at: string | null }[]>`
      select started_at from fake_liker_runs order by started_at desc limit 1`
    if (!data) return null
    return data.started_at ?? null
  } catch {
    return null
  }
}

/** Updates the fake_liker_config singleton row with the given patch, stamping
 * updated_at, and returns the resulting config (null if the update failed). */
export async function updateFakeLikerConfig(
  patch: { enabled?: boolean; maxTargetsPerRun?: number },
): Promise<FakeLikerConfig | null> {
  try {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.enabled !== undefined) updates.enabled = patch.enabled
    if (patch.maxTargetsPerRun !== undefined) updates.max_targets_per_run = patch.maxTargetsPerRun

    const [data] = await sql<{ enabled: boolean; max_targets_per_run: number }[]>`
      update fake_liker_config set ${sql(updates)} where id = true
      returning enabled, max_targets_per_run`
    if (!data) return null
    return { enabled: data.enabled, maxTargetsPerRun: data.max_targets_per_run }
  } catch {
    return null
  }
}
