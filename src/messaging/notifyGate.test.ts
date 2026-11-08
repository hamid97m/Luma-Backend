import { describe, it, expect } from 'vitest'
import { shouldNotifyOffline, canBotDm, isOfflineAndCool, OFFLINE_THRESHOLD_MS, NOTIFY_COOLDOWN_MS, type NotifyRecipient } from './notifyGate.js'

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

  describe('per-gender throttle', () => {
    const woman = { ...base, gender: 'woman' }
    const man = { ...base, gender: 'man' }
    const justNotified = new Date(NOW - 60_000).toISOString()
    const notifiedLongAgo = new Date(NOW - NOTIFY_COOLDOWN_MS - 1000).toISOString()

    it('woman: at most one DM per 4h while she stays offline', () => {
      expect(shouldNotifyOffline({ ...woman, notified_offline_at: justNotified }, NOW)).toBe(false)
      expect(shouldNotifyOffline({ ...woman, notified_offline_at: new Date(NOW - NOTIFY_COOLDOWN_MS + 1000).toISOString() }, NOW)).toBe(false)
    })

    it('woman: gets another DM once the last one is older than 4h', () => {
      expect(shouldNotifyOffline({ ...woman, notified_offline_at: notifiedLongAgo }, NOW)).toBe(true)
    })

    it('man: no throttle — every message while offline is a DM', () => {
      expect(shouldNotifyOffline({ ...man, notified_offline_at: justNotified }, NOW)).toBe(true)
    })

    it('man: still no DM while online', () => {
      expect(shouldNotifyOffline({ ...man, last_active: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false)
    })

    it('nonbinary / unknown gender: throttled like a woman', () => {
      expect(shouldNotifyOffline({ ...base, gender: 'nonbinary', notified_offline_at: justNotified }, NOW)).toBe(false)
      expect(shouldNotifyOffline({ ...base, gender: null, notified_offline_at: justNotified }, NOW)).toBe(false)
      expect(shouldNotifyOffline({ ...base, gender: 'nonbinary', notified_offline_at: notifiedLongAgo }, NOW)).toBe(true)
    })

    it('exposes a 4h cooldown', () => {
      expect(NOTIFY_COOLDOWN_MS).toBe(4 * 60 * 60 * 1000)
    })
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

describe('canBotDm / isOfflineAndCool', () => {
  it('canBotDm is false for a fake id and for declined PMs', () => {
    expect(canBotDm({ telegram_id: -5, allows_write_to_pm: null })).toBe(false)
    expect(canBotDm({ telegram_id: 123, allows_write_to_pm: false })).toBe(false)
    expect(canBotDm({ telegram_id: 123, allows_write_to_pm: null })).toBe(true)
  })

  it('isOfflineAndCool is true for an offline woman with no Telegram id', () => {
    expect(isOfflineAndCool({ ...base, telegram_id: null, gender: 'woman' }, NOW)).toBe(true)
  })
})
