import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifyInitData } from '../src/auth.js'

const BOT_TOKEN = 'test_bot_token'

function makeValidInitData(user: object, botToken = BOT_TOKEN): string {
  const userStr = JSON.stringify(user)
  const params = new URLSearchParams({ user: userStr, auth_date: '9999999999' })
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

describe('verifyInitData', () => {
  it('returns TelegramUser for valid initData', () => {
    const user = { id: 123, first_name: 'Ali', username: 'ali' }
    const result = verifyInitData(makeValidInitData(user), BOT_TOKEN)
    expect(result).toEqual(user)
  })

  it('fails closed (null) when the bot token is empty, even for initData signed with it', () => {
    expect(verifyInitData(makeValidInitData({ id: 123, first_name: 'Ali' }, ''), '')).toBeNull()
  })

  it('keeps the non-production dev_mode bypass working without a bot token', () => {
    expect(verifyInitData('dev_mode', '')).toEqual({ id: 999999, first_name: 'Dev', username: 'devuser' })
  })

  it('returns null for tampered hash', () => {
    const valid = makeValidInitData({ id: 1, first_name: 'X' })
    const tampered = valid.replace(/hash=[^&]+/, 'hash=deadbeef')
    expect(verifyInitData(tampered, BOT_TOKEN)).toBeNull()
  })

  it('returns null when hash is missing', () => {
    expect(verifyInitData('user=%7B%7D&auth_date=0', BOT_TOKEN)).toBeNull()
  })

  it('returns null for expired auth_date', () => {
    const user = { id: 1, first_name: 'Old' }
    // auth_date 48 hours ago
    const expiredTs = Math.floor(Date.now() / 1000) - 48 * 3600
    const params = new URLSearchParams({ user: JSON.stringify(user), auth_date: String(expiredTs) })
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
    params.set('hash', hash)
    expect(verifyInitData(params.toString(), BOT_TOKEN)).toBeNull()
  })
})
