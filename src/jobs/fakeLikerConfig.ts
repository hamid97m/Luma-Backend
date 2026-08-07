import { db } from '../db.js'

export interface FakeLikerConfig {
  enabled: boolean
  maxTargetsPerRun: number
}

/** Reads the fake_liker_config singleton. Never throws: a missing table/row or
 * any query error is treated as "not configured" — callers (job, routes) fall
 * back to a default/disabled state on null. */
export async function getFakeLikerConfig(): Promise<FakeLikerConfig | null> {
  try {
    const { data, error } = await db
      .from('fake_liker_config')
      .select('enabled, max_targets_per_run')
      .eq('id', true)
      .single()
    if (error || !data) return null
    return { enabled: data.enabled, maxTargetsPerRun: data.max_targets_per_run }
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

    const { data, error } = await db
      .from('fake_liker_config')
      .update(updates)
      .eq('id', true)
      .select('enabled, max_targets_per_run')
      .single()
    if (error || !data) return null
    return { enabled: data.enabled, maxTargetsPerRun: data.max_targets_per_run }
  } catch {
    return null
  }
}
