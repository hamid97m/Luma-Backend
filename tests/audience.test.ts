import { describe, it, expect } from 'vitest'
import { chainable } from './admin-helpers.js'
import { applyAudienceFilters } from '../src/messaging/audience.js'

const NOW = 1_000_000_000_000 // fixed clock
const DAY = 86_400_000

function applyWithLog(filters: any) {
  const log: Array<{ method: string; args: unknown[] }> = []
  applyAudienceFilters(chainable(null, log), filters, NOW)
  return log
}

function has(log: Array<{ method: string; args: unknown[] }>, method: string, argMatch: (a: unknown[]) => boolean) {
  return log.some((e) => e.method === method && argMatch(e.args))
}

describe('applyAudienceFilters', () => {
  it('always applies baseline guards (no seed, not banned/deleted, opted-in, real telegram id)', () => {
    const log = applyWithLog({})
    expect(has(log, 'eq', (a) => a[0] === 'is_seed' && a[1] === false)).toBe(true)
    expect(has(log, 'is', (a) => a[0] === 'banned_at' && a[1] === null)).toBe(true)
    expect(has(log, 'is', (a) => a[0] === 'deleted_at' && a[1] === null)).toBe(true)
    expect(has(log, 'gt', (a) => a[0] === 'telegram_id' && a[1] === 0)).toBe(true)
    // opted-in = null OR true (only explicit false is excluded)
    expect(has(log, 'or', (a) => String(a[0]).includes('allows_write_to_pm'))).toBe(true)
  })

  it('maps genders and lookingFor to .in()', () => {
    const log = applyWithLog({ genders: ['female'], lookingFor: ['male', 'female'] })
    expect(has(log, 'in', (a) => a[0] === 'gender' && Array.isArray(a[1]) && (a[1] as string[]).includes('female'))).toBe(true)
    expect(has(log, 'in', (a) => a[0] === 'looking_for' && (a[1] as string[]).length === 2)).toBe(true)
  })

  it('maps activeWithinDays to a lower-bound on last_active', () => {
    const log = applyWithLog({ activity: { activeWithinDays: 7 } })
    expect(has(log, 'gte', (a) => a[0] === 'last_active' && a[1] === new Date(NOW - 7 * DAY).toISOString())).toBe(true)
  })

  it('maps inactiveOverDays to an upper-bound on last_active', () => {
    const log = applyWithLog({ activity: { inactiveOverDays: 30 } })
    expect(has(log, 'lt', (a) => a[0] === 'last_active' && a[1] === new Date(NOW - 30 * DAY).toISOString())).toBe(true)
  })

  it('premium=premium requires premium_until in the future', () => {
    const log = applyWithLog({ premium: 'premium' })
    expect(has(log, 'gt', (a) => a[0] === 'premium_until' && a[1] === new Date(NOW).toISOString())).toBe(true)
  })

  it('premium=free requires premium_until null or past', () => {
    const log = applyWithLog({ premium: 'free' })
    expect(has(log, 'or', (a) => String(a[0]).includes('premium_until'))).toBe(true)
  })
})
