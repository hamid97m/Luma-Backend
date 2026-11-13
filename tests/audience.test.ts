import { describe, it, expect, beforeEach } from 'vitest'
import { countAudience, fetchAudience, fetchPushAudience } from '../src/messaging/audience.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const NOW = Date.parse('2026-09-01T00:00:00.000Z') // fixed clock
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

/** Names of the users the filters select, sorted. */
async function audience(filters: any, channel: 'bot' | 'push' = 'bot'): Promise<string[]> {
  const targets = channel === 'push' ? await fetchPushAudience(filters, NOW) : await fetchAudience(filters, 'bot', NOW)
  const count = await countAudience(filters, channel, NOW)
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
    expect(await fetchAudience({}, 'bot', NOW)).toEqual([{ id: u.id, telegram_id: u.telegram_id }])
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
    expect(await fetchAudience({}, 'bot', NOW)).toHaveLength(1005)
    expect(await countAudience({}, 'bot', NOW)).toBe(1005)
  })

  async function device(userId: string, platform: string, opts: { token?: string; seenMsAgo?: number } = {}) {
    await sql`insert into user_devices (user_id, device_id, platform, push_token, last_seen_at)
      values (${userId}, ${'d-' + Math.random()}, ${platform}, ${opts.token ?? null}, ${iso(Date.now() - (opts.seenMsAgo ?? 0))})`
  }

  it('push channel includes a Google-only user with a token and excludes one without', async () => {
    const g = await createUser({ name: 'googleOnly', telegram_id: -7 })
    await device(g.id, 'android', { token: 'tok-g1' })
    await device(g.id, 'android', { token: 'tok-g2' })
    const t = await createUser({ name: 'noToken' })
    await device(t.id, 'android')
    await createUser({ name: 'noDevice' })
    const seed = await createUser({ name: 'seed', is_seed: true })
    await device(seed.id, 'android', { token: 'tok-s' })
    expect(await audience({}, 'push')).toEqual(['googleOnly'])
    const rows = await fetchPushAudience({}, NOW)
    expect(rows).toEqual([{ id: g.id, tokens: ['tok-g1', 'tok-g2'] }])
    // bot channel is unchanged: Google-only user is not on it
    expect(await audience({})).toEqual(['noDevice', 'noToken'])
  })

  it('platforms filter needs a device of that platform seen in the last 90 days', async () => {
    const fresh = await createUser({ name: 'fresh' })
    await device(fresh.id, 'android', { token: 'tok-f' })
    const old = await createUser({ name: 'old' })
    await device(old.id, 'android', { token: 'tok-o', seenMsAgo: 91 * DAY })
    const web = await createUser({ name: 'web' })
    await device(web.id, 'web')
    expect(await audience({ platforms: ['android'] }, 'push')).toEqual(['fresh'])
    expect(await audience({ platforms: ['android'] })).toEqual(['fresh'])
    expect(await audience({ platforms: ['web'] })).toEqual(['web'])
  })

  it('stores filter needs an Android device from that store seen in the last 90 days; unknown stores match nobody', async () => {
    const baz = await createUser({ name: 'baz' })
    await sql`insert into user_devices (user_id, device_id, platform, store) values (${baz.id}, 'b', 'android', 'bazaar')`
    const myk = await createUser({ name: 'myk' })
    await sql`insert into user_devices (user_id, device_id, platform, store) values (${myk.id}, 'm', 'android', 'myket')`
    const stale = await createUser({ name: 'stale' })
    await sql`insert into user_devices (user_id, device_id, platform, store, last_seen_at)
      values (${stale.id}, 's', 'android', 'bazaar', ${iso(Date.now() - 91 * DAY)})`
    const plain = await createUser({ name: 'plain' })
    await device(plain.id, 'android')
    expect(await audience({ stores: ['bazaar'] })).toEqual(['baz'])
    expect((await audience({ stores: ['bazaar', 'myket'] })).sort()).toEqual(['baz', 'myk'])
    expect(await audience({ stores: ['googleplay' as any] })).toEqual([])
  })
})
