import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed, short-lived photo URLs for the ask answer screen, so the target's
 * real photo URLs (whose storage path carries their user id) never reach a
 * recipient. `<api>/asks/photo/<recipientId>/<index>?exp=<unix>&sig=<hmac>`.
 * No new env: the key is derived from USER_JWT_SECRET (else BOT_TOKEN).
 */

function key(): Buffer {
  const secret = process.env.USER_JWT_SECRET || process.env.BOT_TOKEN || ''
  return createHash('sha256').update(`${secret}:ask-photo`).digest()
}

function sign(recipientId: string, index: number, exp: number): string {
  return createHmac('sha256', key()).update(`${recipientId}|${index}|${exp}`).digest('base64url')
}

function apiBase(): string {
  return (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '')
}

/** Expiry 2-3h ahead, snapped to the hour so a URL stays stable (cacheable) for an hour. */
export function askPhotoExp(nowMs = Date.now()): number {
  return (Math.floor(nowMs / 3_600_000) + 3) * 3600
}

export function askPhotoUrl(recipientId: string, index: number, nowMs = Date.now()): string {
  const exp = askPhotoExp(nowMs)
  return `${apiBase()}/asks/photo/${recipientId}/${index}?exp=${exp}&sig=${sign(recipientId, index, exp)}`
}

export function verifyAskPhotoSig(recipientId: string, index: number, exp: unknown, sig: unknown, nowMs = Date.now()): boolean {
  const e = Number(exp)
  if (!Number.isInteger(e) || e * 1000 <= nowMs || typeof sig !== 'string') return false
  const expected = Buffer.from(sign(recipientId, index, e))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
