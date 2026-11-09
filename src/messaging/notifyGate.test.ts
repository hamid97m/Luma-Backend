import { describe, it, expect } from 'vitest'
import { isOffline, canBotDm, OFFLINE_THRESHOLD_MS, CHAT_NOTIFY_WINDOW_MS } from './notifyGate.js'
import * as gate from './notifyGate.js'

const NOW = 1_700_000_000_000

describe('isOffline', () => {
  it('is true when last_active is missing or older than the threshold', () => {
    expect(isOffline({ last_active: null }, NOW)).toBe(true)
    expect(isOffline({ last_active: new Date(NOW - OFFLINE_THRESHOLD_MS - 1000).toISOString() }, NOW)).toBe(true)
  })

  it('is false for a recipient active within the threshold', () => {
    expect(isOffline({ last_active: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false)
  })
})

describe('canBotDm', () => {
  it('is false for a fake/null id and for declined PMs', () => {
    expect(canBotDm({ telegram_id: -5, allows_write_to_pm: null })).toBe(false)
    expect(canBotDm({ telegram_id: null, allows_write_to_pm: null })).toBe(false)
    expect(canBotDm({ telegram_id: 123, allows_write_to_pm: false })).toBe(false)
  })

  it('is true for a real Telegram id that allows PMs (or has not said)', () => {
    expect(canBotDm({ telegram_id: 123, allows_write_to_pm: null })).toBe(true)
    expect(canBotDm({ telegram_id: 123, allows_write_to_pm: true })).toBe(true)
  })
})

describe('message notification constants', () => {
  it('bot DM window is 10 minutes per chat', () => {
    expect(CHAT_NOTIFY_WINDOW_MS).toBe(10 * 60 * 1000)
  })

  it('the old global 4h cooldown and the daily cap are gone', () => {
    expect('NOTIFY_COOLDOWN_MS' in gate).toBe(false)
    expect('isCooledDown' in gate).toBe(false)
    expect('DAILY_NOTIFY_CAP' in gate).toBe(false)
  })
})
