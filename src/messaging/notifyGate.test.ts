import { describe, it, expect } from 'vitest'
import { shouldNotifyOffline, OFFLINE_THRESHOLD_MS, type NotifyRecipient } from './notifyGate.js'

const NOW = 1_700_000_000_000
const base: NotifyRecipient = {
  telegram_id: 123,
  last_active: new Date(NOW - OFFLINE_THRESHOLD_MS - 1000).toISOString(), // offline
  notified_offline_at: null,
  allows_write_to_pm: null,
}

describe('shouldNotifyOffline', () => {
  it('notifies an offline recipient not yet notified', () => {
    expect(shouldNotifyOffline(base, NOW)).toBe(true)
  })

  it('notifies when last_active is missing (never seen)', () => {
    expect(shouldNotifyOffline({ ...base, last_active: null }, NOW)).toBe(true)
  })

  it('does NOT notify a recipient active within the threshold', () => {
    const online = { ...base, last_active: new Date(NOW - 60_000).toISOString() }
    expect(shouldNotifyOffline(online, NOW)).toBe(false)
  })

  it('does NOT notify if already notified this offline stretch', () => {
    expect(shouldNotifyOffline({ ...base, notified_offline_at: new Date(NOW).toISOString() }, NOW)).toBe(false)
  })

  it('does NOT notify if the recipient declined PM (allows_write_to_pm === false)', () => {
    expect(shouldNotifyOffline({ ...base, allows_write_to_pm: false }, NOW)).toBe(false)
  })

  it('notifies when allows_write_to_pm is true', () => {
    expect(shouldNotifyOffline({ ...base, allows_write_to_pm: true }, NOW)).toBe(true)
  })

  it('does NOT notify a fake recipient (non-positive telegram_id)', () => {
    expect(shouldNotifyOffline({ ...base, telegram_id: -42 }, NOW)).toBe(false)
    expect(shouldNotifyOffline({ ...base, telegram_id: null }, NOW)).toBe(false)
  })
})
