import { describe, it, expect, beforeEach } from 'vitest'
import { getReferralConfig, updateReferralConfig, referralOpenTo } from '../src/referrals/config.js'
import { resetDb, sql } from './helpers/db.js'
import { failWritesTo } from './helpers/gifts-referrals.js'

beforeEach(() => resetDb())

describe('getReferralConfig', () => {
  it('returns the config when the row exists', async () => {
    await sql`update referral_config set enabled = true`
    expect(await getReferralConfig()).toEqual({ enabled: true, audience: 'all' })
  })

  it('returns the default (disabled) config of a fresh install', async () => {
    expect(await getReferralConfig()).toEqual({ enabled: false, audience: 'all' })
  })

  it('returns null when no row is found', async () => {
    await sql`delete from referral_config`
    expect(await getReferralConfig()).toBeNull()
  })

  it('never throws — returns null when the query errors', async () => {
    await sql`alter table referral_config rename to referral_config_x`
    try {
      await expect(getReferralConfig()).resolves.toBeNull()
    } finally {
      await sql`alter table referral_config_x rename to referral_config`
    }
  })
})

describe('updateReferralConfig', () => {
  it('persists enabled, bumps updated_at and returns the fresh row', async () => {
    await sql`update referral_config set updated_at = '2020-01-01T00:00:00Z'`
    expect(await updateReferralConfig({ enabled: true })).toEqual({ enabled: true, audience: 'all' })
    const [row] = await sql`select enabled, updated_at from referral_config`
    expect(row.enabled).toBe(true)
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('leaves enabled untouched when not provided in the patch (only updated_at changes)', async () => {
    await sql`update referral_config set enabled = true, updated_at = '2020-01-01T00:00:00Z'`
    expect(await updateReferralConfig({})).toEqual({ enabled: true, audience: 'all' })
    const [row] = await sql`select updated_at from referral_config`
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('returns null when there is no config row', async () => {
    await sql`delete from referral_config`
    expect(await updateReferralConfig({ enabled: true })).toBeNull()
  })

  it('never throws — returns null when the update errors', async () => {
    const cleanup = await failWritesTo('referral_config', 'UPDATE')
    try {
      await expect(updateReferralConfig({ enabled: true })).resolves.toBeNull()
    } finally {
      await cleanup()
    }
  })
})

describe('audience', () => {
  it('persists the audience and leaves it alone when not in the patch', async () => {
    expect(await updateReferralConfig({ enabled: true, audience: 'women' })).toEqual({ enabled: true, audience: 'women' })
    expect(await updateReferralConfig({ enabled: false })).toEqual({ enabled: false, audience: 'women' })
    expect(await getReferralConfig()).toEqual({ enabled: false, audience: 'women' })
  })

  it('referralOpenTo: off for everyone when disabled or missing', () => {
    expect(referralOpenTo(null, 'woman')).toBe(false)
    expect(referralOpenTo({ enabled: false, audience: 'all' }, 'woman')).toBe(false)
  })

  it.each([
    ['all', { man: true, woman: true, nonbinary: true }],
    ['women', { man: false, woman: true, nonbinary: false }],
    ['men', { man: true, woman: false, nonbinary: false }],
  ] as const)('referralOpenTo: audience %s', (audience, expected) => {
    for (const [gender, open] of Object.entries(expected)) {
      expect(referralOpenTo({ enabled: true, audience }, gender)).toBe(open)
    }
  })
})
