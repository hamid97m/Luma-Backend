import { db } from '../db.js'

export interface ReferralConfig {
  enabled: boolean
}

export async function getReferralConfig(): Promise<ReferralConfig | null> {
  try {
    const { data, error } = await db
      .from('referral_config')
      .select('enabled')
      .eq('id', true)
      .maybeSingle()
    if (error || !data) return null
    return { enabled: data.enabled === true }
  } catch {
    return null
  }
}

export async function updateReferralConfig(
  patch: Partial<ReferralConfig>
): Promise<ReferralConfig | null> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof patch.enabled === 'boolean') update.enabled = patch.enabled
  try {
    const { data, error } = await db
      .from('referral_config')
      .update(update)
      .eq('id', true)
      .select('enabled')
      .maybeSingle()
    if (error || !data) return null
    return { enabled: data.enabled === true }
  } catch {
    return null
  }
}
