import { createHmac, timingSafeEqual } from 'crypto'
import type { TelegramUser } from './types.js'

export function verifyInitData(initData: string, botToken: string): TelegramUser | null {
  // Dev bypass — lets you test in a regular browser without Telegram
  if (process.env.NODE_ENV !== 'production' && initData === 'dev_mode') {
    return { id: 999999, first_name: 'Dev', username: 'devuser' }
  }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  params.delete('hash')

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (hash.length !== 64) return null
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null

  // Reject tokens older than 24 hours
  const authDate = params.get('auth_date')
  if (!authDate || Date.now() / 1000 - Number(authDate) > 86400) return null

  const userStr = params.get('user')
  if (!userStr) return null

  try {
    return JSON.parse(userStr) as TelegramUser
  } catch {
    return null
  }
}
