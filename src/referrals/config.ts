import { sql } from '../db.js'

/** Who may invite (see the feature and earn its rewards) while the program is on. */
export type ReferralAudience = 'all' | 'women' | 'men'
export const REFERRAL_AUDIENCES: ReferralAudience[] = ['all', 'women', 'men']

export interface ReferralConfig {
  enabled: boolean
  audience: ReferralAudience
}

type Row = { enabled: boolean; audience: string }

function toConfig(row: Row): ReferralConfig {
  const audience = (REFERRAL_AUDIENCES as string[]).includes(row.audience) ? (row.audience as ReferralAudience) : 'all'
  return { enabled: row.enabled === true, audience }
}

/**
 * Is the program on for an inviter of this gender? Outside the audience it behaves
 * exactly like the program being off: hidden in the app, no rewards (signups from
 * their links are still recorded and pay out if the audience opens up later).
 */
export function referralOpenTo(config: ReferralConfig | null, gender: string | null | undefined): boolean {
  if (!config?.enabled) return false
  if (config.audience === 'women') return gender === 'woman'
  if (config.audience === 'men') return gender === 'man'
  return true
}

export async function getReferralConfig(): Promise<ReferralConfig | null> {
  try {
    const [data] = await sql<Row[]>`select enabled, audience from referral_config where id = true`
    if (!data) return null
    return toConfig(data)
  } catch {
    return null
  }
}

export async function updateReferralConfig(
  patch: Partial<ReferralConfig>
): Promise<ReferralConfig | null> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof patch.enabled === 'boolean') update.enabled = patch.enabled
  if (patch.audience && REFERRAL_AUDIENCES.includes(patch.audience)) update.audience = patch.audience
  try {
    const [data] = await sql<Row[]>`
      update referral_config set ${sql(update)} where id = true returning enabled, audience`
    if (!data) return null
    return toConfig(data)
  } catch {
    return null
  }
}
