import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, createHmac } from 'crypto'

// Referrals area — not under test here.
vi.mock('../src/referrals/attribution.js', () => ({
  captureReferralAttribution: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { verifyTelegramWidget } from '../src/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const BOT_TOKEN = 'test_widget_bot_token'

/** A Login Widget payload signed the way Telegram signs it. */
function signWidget(fields: Record<string, string | number>, botToken = BOT_TOKEN) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n')
  const secret = createHash('sha256').update(botToken).digest()
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex')
  return { ...fields, hash }
}

const now = () => Math.floor(Date.now() / 1000)

describe('verifyTelegramWidget', () => {
  it('returns the user for a valid payload', () => {
    const payload = signWidget({ id: 42, first_name: 'Ali', username: 'ali', auth_date: now() })
    expect(verifyTelegramWidget(payload, BOT_TOKEN)).toEqual({ id: 42, first_name: 'Ali', username: 'ali' })
  })

  it('returns null when signed with another bot token', () => {
    const payload = signWidget({ id: 42, first_name: 'Ali', auth_date: now() }, 'other_token')
    expect(verifyTelegramWidget(payload, BOT_TOKEN)).toBeNull()
  })

  it('returns null when the hash is missing or malformed', () => {
    expect(verifyTelegramWidget({ id: 42, first_name: 'Ali', auth_date: now() }, BOT_TOKEN)).toBeNull()
    expect(verifyTelegramWidget({ id: 42, first_name: 'Ali', auth_date: now(), hash: 'abc' }, BOT_TOKEN)).toBeNull()
  })
})

describe('POST /auth/telegram-web', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    vi.stubEnv('BOT_TOKEN', BOT_TOKEN)
    await resetDb()
    app = await buildApp()
  })
  afterEach(() => { vi.unstubAllEnvs() })

  // No Authorization header anywhere below: the auth preHandler must skip this route.
  const login = (payload: object) => app.inject({ method: 'POST', url: '/auth/telegram-web', payload })

  it('valid widget payload for existing telegram user returns token + that user\'s id', async () => {
    const u = await createUser({ telegram_id: 4242, name: 'Sara', age: 0 })

    const res = await login(signWidget({ id: 4242, first_name: 'Sara', auth_date: now() }))

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.token).toBe('string')
    expect(body.user).toMatchObject({ id: u.id, name: 'Sara' })
    expect(await sql`select id from users`).toHaveLength(1)
  })

  it('creates a new telegram user', async () => {
    const res = await login(signWidget({
      id: 777, first_name: 'Reza', last_name: 'K', username: 'reza',
      photo_url: 'https://t.me/i/userpic/320/reza.jpg', auth_date: now(),
    }))

    expect(res.statusCode).toBe(200)
    const [row] = await sql`select id, telegram_id, username, name from users`
    expect(row).toMatchObject({ telegram_id: 777, username: 'reza', name: 'Reza' })
    expect(res.json().user).toEqual({ id: row.id, name: 'Reza', setupComplete: false, locale: null })
  })

  it('tampered field → 401 invalid_telegram_login', async () => {
    const payload = signWidget({ id: 4242, first_name: 'Sara', auth_date: now() })

    const res = await login({ ...payload, id: 1 })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_telegram_login' })
  })

  it('auth_date 2 days old → 401', async () => {
    const res = await login(signWidget({ id: 4242, first_name: 'Sara', auth_date: now() - 2 * 86400 }))

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_telegram_login' })
  })

  it('missing body → 400 missing_telegram_login', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/telegram-web' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing_telegram_login' })
  })

  it('banned user → 401 account_banned', async () => {
    await createUser({ telegram_id: 4242, banned_at: '2026-10-01T00:00:00Z' })

    const res = await login(signWidget({ id: 4242, first_name: 'Sara', auth_date: now() }))

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'account_banned' })
  })

  it('returned token works on GET /auth/me', async () => {
    const u = await createUser({ telegram_id: 4242, name: 'Sara', age: 0 })
    const { token } = (await login(signWidget({ id: 4242, first_name: 'Sara', auth_date: now() }))).json()

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })

    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ id: u.id, name: 'Sara' })
  })
})

describe('POST /auth/dev', () => {
  beforeEach(async () => { await resetDb() })
  afterEach(() => { vi.unstubAllEnvs() })

  it('signs in the dev user without any Authorization header', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/auth/dev' })

    expect(res.statusCode).toBe(200)
    const [row] = await sql`select id, telegram_id, username, name from users`
    expect(row).toMatchObject({ telegram_id: 999999, username: 'devuser', name: 'Dev' })
    const { token, user } = res.json()
    expect(user).toMatchObject({ id: row.id, name: 'Dev' })
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.json().user).toMatchObject({ id: row.id })
  })

  it('is not registered in production (404)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('WEB_URL', 'https://app.example.test')
    vi.stubEnv('LOG_LEVEL', 'silent')
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/auth/dev' })

    expect(res.statusCode).toBe(404)
    expect(await sql`select id from users`).toHaveLength(0)
  })
})
