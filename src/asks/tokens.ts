import { createHash, randomBytes } from 'node:crypto'
import { getBotUsername } from '../bot.js'

/** 128-bit random link token (base64url). Only its sha256 is stored. */
export function newAskToken(): string {
  return randomBytes(16).toString('base64url')
}

export function hashAskToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/** A token as the client sends it; anything else can't be one of ours. */
export function isAskTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token)
}

/** The shareable Telegram link. ASK_LINK_BASE overrides the default
 *  `https://t.me/<bot>?startapp=` (that form needs the bot's Main Mini App;
 *  otherwise use `https://t.me/<bot>/<shortname>?startapp=`). */
export function askLink(token: string): string {
  const base = process.env.ASK_LINK_BASE?.trim()
    || `https://t.me/${getBotUsername() ?? 'LumaDatingBot'}?startapp=`
  return `${base}ask_${token}`
}
