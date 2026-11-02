import { describe, it, expect, beforeEach } from 'vitest'
import { countAudience, fetchAudience } from '../src/messaging/audience.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const NOW = Date.parse('2026-09-01T00:00:00.000Z') // fixed clock
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

/** Names of the users the filters select, sorted. */
async function audience(filters: any): Promise<string[]> {
  const targets = await fetchAudience(filters, NOW)
  const count = await countAudience(filters, NOW)
  expect(count).toBe(targets.length) // preview count and send list always agree
  if (!targets.length) return []
  const rows = await sql<{ name: string }[]>`select name from users where id = any(${targets.map((t) => t.id)}::uuid[])`
  return rows.map((r) => r.name).sort()
}

describe('broadcast audience', () => {
  beforeEach(resetDb)

  it('always applies baseline guards (no seed, not banned/deleted, opted-in, real telegram id)', async () => {
    await createUser({ name: 'ok' })
    await createUser({ name: 'optedInNull', allows_write_to_pm: null })
    await createUser({ name: 'optedInTrue', allows_write_to_pm: true })
    await createUser({ name: 'optedOut', allows_write_to_pm: false })
    await createUser({ name: 'seed', is_seed: true })
    await createUser({ name: 'banned', banned_at: iso(NOW) })
    await createUser({ name: 'deleted', deleted_at: iso(NOW) })
    await createUser({ name: 'fakeTg', telegram_id: -5 })
    expect(await audience({})).toEqual(['ok', 'optedInNull', 'optedInTrue'])
  })

  it('returns id + telegram_id per target', async () => {
    const u = await createUser({ name: 'ok' })
    expect(await fetchAudience({}, NOW)).toEqual([{ id: u.id, telegram_id: u.telegram_id }])
  })

  it('filters by genders and lookingFor', async () => {
    await createUser({ name: 'w-men', gender: 'woman', looking_for: 'men' })
    await createUser({ name: 'w-both', gender: 'woman', looking_for: 'both' })
    await createUser({ name: 'm-women', gender: 'man', looking_for: 'women' })
    expect(await audience({ genders: ['woman'] })).toEqual(['w-both', 'w-men'])
    expect(await audience({ genders: ['woman'], lookingFor: ['men', 'women'] })).toEqual(['w-men'])
  })

  it('an unknown enum value matches nobody instead of erroring', async () => {
    await createUser({ name: 'm' })
    expect(await audience({ genders: ['female'] })).toEqual([])
  })

  it('activeWithinDays is a lower bound on last_active; inactiveOverDays an upper bound', async () => {
    await createUser({ name: 'fresh', last_active: iso(NOW - 1 * DAY) })
    await createUser({ name: 'week', last_active: iso(NOW - 10 * DAY) })
    await createUser({ name: 'stale', last_active: iso(NOW - 40 * DAY) })
    expect(await audience({ activity: { activeWithinDays: 7 } })).toEqual(['fresh'])
    expect(await audience({ activity: { inactiveOverDays: 30 } })).toEqual(['stale'])
  })

  it('premium=premium requires premium_until in the future; free = null or past', async () => {
    await createUser({ name: 'premium', premium_until: iso(NOW + DAY) })
    await createUser({ name: 'expired', premium_until: iso(NOW - DAY) })
    await createUser({ name: 'never' })
    expect(await audience({ premium: 'premium' })).toEqual(['premium'])
    expect(await audience({ premium: 'free' })).toEqual(['expired', 'never'])
  })

  it('filters by locale and ignores the filter when absent/empty', async () => {
    await createUser({ name: 'en', locale: 'en' })
    await createUser({ name: 'ar', locale: 'ar' })
    await createUser({ name: 'none' })
    expect(await audience({ locales: ['en', 'ar'] })).toEqual(['ar', 'en'])
    expect(await audience({})).toEqual(['ar', 'en', 'none'])
    expect(await audience({ locales: [] })).toEqual(['ar', 'en', 'none'])
  })

  it('drops unknown locale values but fails closed when none remain', async () => {
    await createUser({ name: 'en', locale: 'en' })
    await createUser({ name: 'fa', locale: 'fa' })
    expect(await audience({ locales: ['de', 'en'] })).toEqual(['en'])
    // An all-invalid list must match nobody — never silently broadcast to everyone.
    expect(await audience({ locales: ['de'] })).toEqual([])
  })

  it('returns more than 1000 targets in one call (no page cap)', async () => {
      await sql`
      insert into users (telegram_id, name, age, gender, looking_for, account_status)
      select 5000000 + g, 'bulk', 28, 'man', 'women', 'active' from generate_series(1, 1005) g`
    expect(await fetchAudience({}, NOW)).toHaveLength(1005)
    expect(await countAudience({}, NOW)).toBe(1005)
  })
})
