import { createHash, createHmac, timingSafeEqual } from 'crypto'
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

/** Telegram Login Widget (website sign-in). Unlike initData, the secret is the
 *  raw SHA-256 of the bot token and the user fields arrive flat. */
export function verifyTelegramWidget(
  data: Record<string, string | number>,
  botToken: string,
): TelegramUser | null {
  const { hash, ...fields } = data
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return null

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n')

  const secretKey = createHash('sha256').update(botToken).digest()
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null

  // Reject logins older than 24 hours
  const authDate = Number(fields.auth_date)
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null

  const id = Number(fields.id)
  if (!Number.isSafeInteger(id) || id <= 0 || typeof fields.first_name !== 'string') return null

  return {
    id,
    first_name: fields.first_name,
    ...(typeof fields.last_name === 'string' ? { last_name: fields.last_name } : {}),
    ...(typeof fields.username === 'string' ? { username: fields.username } : {}),
  }
}
