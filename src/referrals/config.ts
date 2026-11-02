import { sql } from '../db.js'

export interface ReferralConfig {
  enabled: boolean
}

export async function getReferralConfig(): Promise<ReferralConfig | null> {
  try {
    const [data] = await sql<{ enabled: boolean }[]>`select enabled from referral_config where id = true`
    if (!data) return null
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
    const [data] = await sql<{ enabled: boolean }[]>`
      update referral_config set ${sql(update)} where id = true returning enabled`
    if (!data) return null
    return { enabled: data.enabled === true }
  } catch {
    return null
  }
}
