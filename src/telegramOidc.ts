import { createPublicKey, type KeyObject } from 'crypto'
import jwt from 'jsonwebtoken'
import type { TelegramUser } from './types.js'

// "Log in with Telegram" (OpenID Connect), used by the Android app's native
// Telegram login. Spec: https://core.telegram.org/bots/telegram-login
export const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org'
const JWKS_URL = `${TELEGRAM_OIDC_ISSUER}/.well-known/jwks.json`
const JWKS_TTL_MS = 60 * 60_000
// An unknown kid triggers a refetch (key rotation), but at most this often.
const JWKS_MIN_REFETCH_MS = 60_000
// EdDSA / ES256K tokens never carry the `profile` claims we need (the user id).
const ALGORITHMS: jwt.Algorithm[] = ['RS256', 'ES256']

let keys = new Map<string, KeyObject>()
let fetchedAt = 0

export function resetTelegramJwksCache() {
  keys = new Map()
  fetchedAt = 0
}

async function loadKeys(): Promise<void> {
  const res = await fetch(JWKS_URL)
  if (!res.ok) throw new Error(`telegram jwks ${res.status}`)
  const body = (await res.json()) as { keys?: (Record<string, unknown> & { kid?: string })[] }
  const next = new Map<string, KeyObject>()
  for (const jwk of body.keys ?? []) {
    if (typeof jwk.kid !== 'string') continue
    try {
      next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }))
    } catch {
      // A key type this Node can't import (e.g. secp256k1) — not one we accept anyway.
    }
  }
  keys = next
  fetchedAt = Date.now()
}

async function keyFor(kid: string): Promise<KeyObject | null> {
  const stale = Date.now() - fetchedAt > JWKS_TTL_MS
  const canRefetch = Date.now() - fetchedAt > JWKS_MIN_REFETCH_MS
  if (stale || (!keys.has(kid) && canRefetch)) await loadKeys()
  return keys.get(kid) ?? null
}

/** Accepted `aud` values: TELEGRAM_LOGIN_CLIENT_IDS (comma-separated), else
 *  the bot id from BOT_TOKEN — BotFather's Client ID is the bot's id. */
function audiences(): string[] {
  const configured = (process.env.TELEGRAM_LOGIN_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (configured.length > 0) return configured
  const botId = (process.env.BOT_TOKEN ?? '').split(':')[0]
  return /^\d+$/.test(botId) ? [botId] : []
}

/** The Telegram user inside a valid Telegram OIDC ID token; null if the token
 *  is invalid, expired, meant for another app, or lacks the numeric user id
 *  (the `id` claim — `sub` is NOT the Telegram user id). */
export async function verifyTelegramIdToken(idToken: string): Promise<TelegramUser | null> {
  const audience = audiences()
  if (audience.length === 0) return null

  const decoded = jwt.decode(idToken, { complete: true })
  const kid = decoded?.header.kid
  if (!kid) return null

  let payload: jwt.JwtPayload
  try {
    const key = await keyFor(kid)
    if (!key) return null
    const verified = jwt.verify(idToken, key, { algorithms: ALGORITHMS, issuer: TELEGRAM_OIDC_ISSUER })
    // jwt.verify enforces exp only when present; a token must have one.
    if (typeof verified !== 'object' || verified === null || typeof verified.exp !== 'number') return null
    payload = verified
  } catch {
    return null
  }

  // Checked here, not by jwt.verify: the bot id may come as a number.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud.some((a) => a !== undefined && audience.includes(String(a)))) return null

  const id = Number(payload.id)
  if (!Number.isSafeInteger(id) || id <= 0) return null

  const firstName =
    (typeof payload.given_name === 'string' && payload.given_name.trim()) ||
    (typeof payload.name === 'string' && payload.name.trim()) ||
    ''
  const username = typeof payload.preferred_username === 'string' && payload.preferred_username
    ? payload.preferred_username
    : undefined
  return { id, first_name: firstName, ...(username ? { username } : {}) }
}
