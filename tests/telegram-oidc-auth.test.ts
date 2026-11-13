import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'

// Referrals area — not under test here.
vi.mock('../src/referrals/attribution.js', () => ({
  captureReferralAttribution: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { verifyTelegramIdToken, resetTelegramJwksCache, TELEGRAM_OIDC_ISSUER } from '../src/telegramOidc.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const BOT_ID = '8123456789'
const BOT_TOKEN = `${BOT_ID}:test_oidc_bot_token`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'oidc-1', alg: 'RS256' }] }

const fetchMock = vi.fn()

/** An ID token shaped like Telegram's (scopes openid + profile). */
function signToken(claims: Record<string, unknown> = {}, opts: { key?: typeof privateKey; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: TELEGRAM_OIDC_ISSUER, aud: BOT_ID, sub: '1234123412341234123', iat: now, exp: now + 300,
    id: 987654321, name: 'Ali Rezaei', given_name: 'Ali', preferred_username: 'ali',
    ...claims,
  }
  // `undefined` in claims = leave that claim out.
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
  return jwt.sign(
    payload,
    opts.key ?? privateKey,
    { algorithm: 'RS256', keyid: opts.kid ?? 'oidc-1' },
  )
}

beforeEach(() => {
  resetTelegramJwksCache()
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => jwks })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('BOT_TOKEN', BOT_TOKEN)
  vi.stubEnv('TELEGRAM_LOGIN_CLIENT_IDS', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('verifyTelegramIdToken', () => {
  it('returns the Telegram user from the `id` claim (not `sub`)', async () => {
    expect(await verifyTelegramIdToken(signToken())).toEqual({ id: 987654321, first_name: 'Ali', username: 'ali' })
  })

  it('accepts a numeric aud and falls back to `name` without given_name/username', async () => {
    const token = signToken({ aud: Number(BOT_ID), given_name: undefined, preferred_username: undefined })
    expect(await verifyTelegramIdToken(token)).toEqual({ id: 987654321, first_name: 'Ali Rezaei' })
  })

  it('uses TELEGRAM_LOGIN_CLIENT_IDS when set', async () => {
    vi.stubEnv('TELEGRAM_LOGIN_CLIENT_IDS', '111, 222')
    expect(await verifyTelegramIdToken(signToken())).toBeNull()
    expect(await verifyTelegramIdToken(signToken({ aud: '222' }))).toMatchObject({ id: 987654321 })
  })

  it('rejects a token for another app, another issuer, expired, or without exp', async () => {
    expect(await verifyTelegramIdToken(signToken({ aud: '999' }))).toBeNull()
    expect(await verifyTelegramIdToken(signToken({ iss: 'https://evil.example' }))).toBeNull()
    const past = Math.floor(Date.now() / 1000) - 600
    expect(await verifyTelegramIdToken(signToken({ iat: past - 300, exp: past }))).toBeNull()
    expect(await verifyTelegramIdToken(signToken({ exp: undefined }))).toBeNull()
  })

  it('rejects a token signed with an unknown key or an unknown kid', async () => {
    expect(await verifyTelegramIdToken(signToken({}, { key: other.privateKey }))).toBeNull()
    expect(await verifyTelegramIdToken(signToken({}, { kid: 'nope' }))).toBeNull()
  })

  it('rejects a token without the numeric `id` claim (profile scope missing)', async () => {
    expect(await verifyTelegramIdToken(signToken({ id: undefined }))).toBeNull()
    expect(await verifyTelegramIdToken(signToken({ id: 'abc' }))).toBeNull()
  })

  it('rejects an HS256 token signed with the public key (alg confusion)', async () => {
    const pem = publicKey.export({ format: 'pem', type: 'spki' })
    const now = Math.floor(Date.now() / 1000)
    const forged = jwt.sign(
      { iss: TELEGRAM_OIDC_ISSUER, aud: BOT_ID, id: 1, exp: now + 300 }, pem, { algorithm: 'HS256', keyid: 'oidc-1' },
    )
    expect(await verifyTelegramIdToken(forged)).toBeNull()
  })

  it('fails closed with no audience configured, and on garbage input', async () => {
    vi.stubEnv('BOT_TOKEN', '')
    expect(await verifyTelegramIdToken(signToken())).toBeNull()
    vi.stubEnv('BOT_TOKEN', BOT_TOKEN)
    expect(await verifyTelegramIdToken('not-a-jwt')).toBeNull()
  })

  it('caches the key set', async () => {
    await verifyTelegramIdToken(signToken())
    await verifyTelegramIdToken(signToken())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when the key set cannot be fetched', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })
    expect(await verifyTelegramIdToken(signToken())).toBeNull()
  })
})

describe('POST /auth/telegram-oidc', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
  })

  // No Authorization header anywhere below: the auth preHandler must skip this route.
  const login = (payload?: object) => app.inject({ method: 'POST', url: '/auth/telegram-oidc', payload })

  it('signs an existing Telegram user into the same account', async () => {
    const u = await createUser({ telegram_id: 987654321, name: 'Ali' })

    const res = await login({ idToken: signToken() })

    expect(res.statusCode).toBe(200)
    const { token, user } = res.json()
    expect(user).toMatchObject({ id: u.id })
    expect(await sql`select id from users`).toHaveLength(1)
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.json().user).toMatchObject({ id: u.id })
  })

  it('creates a new account keyed by the Telegram id', async () => {
    const res = await login({ idToken: signToken() })

    expect(res.statusCode).toBe(200)
    const [row] = await sql`select telegram_id, username, name from users`
    expect(row).toMatchObject({ telegram_id: 987654321, username: 'ali', name: 'Ali' })
  })

  it('invalid token → 401, no user created', async () => {
    const res = await login({ idToken: signToken({ aud: '999' }) })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_telegram_login' })
    expect(await sql`select id from users`).toHaveLength(0)
  })

  it('missing idToken → 400', async () => {
    for (const payload of [undefined, {}, { idToken: '' }, { idToken: 42 }]) {
      const res = await login(payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'missing_id_token' })
    }
  })
})
