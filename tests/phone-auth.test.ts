import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/phone/mediana.js', () => ({
  isSmsConfigured: vi.fn().mockReturnValue(true),
  sendOtpSms: vi.fn().mockResolvedValue(true),
}))

import { buildApp } from '../src/server.js'
import { sendOtpSms, isSmsConfigured } from '../src/phone/mediana.js'
import { signSessionToken } from '../src/session.js'
import { normalizeIranMobile } from '../src/phone/normalize.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const ANDROID = { 'x-client-platform': 'android', 'x-device-id': 'dev-1' }
const PHONE = '09121234567'

type App = Awaited<ReturnType<typeof buildApp>>

/** The code handed to the SMS sender on its last call. */
function lastCode(): string {
  const calls = vi.mocked(sendOtpSms).mock.calls
  return calls[calls.length - 1][1]
}
const wrong = (code: string) => (code === '00000' ? '11111' : '00000')

/** Pretend earlier codes were sent long enough ago to skip the resend cooldown. */
async function ageCodes(seconds = 61) {
  await sql`update phone_otp_codes set created_at = created_at - make_interval(secs => ${seconds})`
}

const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = ANDROID) =>
  app.inject({ method: 'POST', url, payload: payload as any, headers })

describe('normalizeIranMobile', () => {
  it.each([
    ['09121234567', '09121234567'],
    ['9121234567', '09121234567'],
    ['+989121234567', '09121234567'],
    ['989121234567', '09121234567'],
    ['00989121234567', '09121234567'],
    ['0912 123 4567', '09121234567'],
    ['(0912) 123-4567', '09121234567'],
    ['۰۹۱۲۱۲۳۴۵۶۷', '09121234567'],
    ['٠٩١٢١٢٣٤٥٦٧', '09121234567'],
    ['09360528920', '09360528920'],
    ['09011234567', '09011234567'],
    ['09211234567', '09211234567'],
    ['09411234567', '09411234567'],
    ['09981234567', '09981234567'],
    ['‎0912‌123 4567‏', '09121234567'],
  ])('%s → %s', (raw, out) => expect(normalizeIranMobile(raw)).toBe(out))

  it.each([
    '', '0912123456', '091212345678', '02112345678', '+14155550100', '08121234567', 'abc', 123,
    '09001234567', '09061234567', '09241234567', '09401234567', '09501234567',
  ])(
    'rejects %s', (raw) => expect(normalizeIranMobile(raw)).toBeNull())
})

describe('phone login', () => {
  let app: App

  beforeEach(async () => {
    vi.mocked(sendOtpSms).mockResolvedValue(true)
    vi.mocked(isSmsConfigured).mockReturnValue(true)
    await resetDb()
    app = await buildApp()
  })

  it('request sends a 5-digit code to the normalized phone and stores only its hash', async () => {
    const res = await post(app, '/auth/phone/request', { phone: '+989121234567' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, expiresIn: 120, resendIn: 60 })
    expect(vi.mocked(sendOtpSms).mock.calls[0][0]).toBe(PHONE)
    expect(lastCode()).toMatch(/^\d{5}$/)
    const [row] = await sql`select phone, purpose, user_id, code_hash from phone_otp_codes`
    expect(row).toMatchObject({ phone: PHONE, purpose: 'login', user_id: null })
    expect(row.code_hash).not.toContain(lastCode())
  })

  it('is native only', async () => {
    for (const headers of [{}, { 'x-client-platform': 'web' }, { 'x-client-platform': 'telegram' }]) {
      const res = await post(app, '/auth/phone/request', { phone: PHONE }, headers)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'native_only' })
    }
    expect(sendOtpSms).not.toHaveBeenCalled()
  })

  it('rejects non-Iranian / malformed numbers', async () => {
    const res = await post(app, '/auth/phone/request', { phone: '+14155550100' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_phone' })
  })

  it('verify creates a new account and returns a session token', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const [user] = await sql`select id, phone, telegram_id, name, age from users`
    expect(user).toMatchObject({ phone: PHONE, telegram_id: null, name: '', age: 0 })
    expect(body).toMatchObject({ isNewUser: true, user: { id: user.id, setupComplete: false } })

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${body.token}` } })
    expect(me.statusCode).toBe(200)
  })

  it('verify signs in the existing account for that phone', async () => {
    const u = await createUser({ phone: PHONE })
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.statusCode).toBe(200)
    expect(res.json().isNewUser).toBe(false)
    expect(res.json().user.id).toBe(u.id)
    expect(res.json().user.phone).toBe(PHONE)
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(1)
  })

  it('accepts a code typed in Persian digits', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const fa = lastCode().replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])
    expect((await post(app, '/auth/phone/verify', { phone: PHONE, code: fa })).statusCode).toBe(200)
  })

  it('a code works once', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const code = lastCode()
    expect((await post(app, '/auth/phone/verify', { phone: PHONE, code })).statusCode).toBe(200)
    const again = await post(app, '/auth/phone/verify', { phone: PHONE, code })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toEqual({ error: 'code_expired' })
  })

  it('wrong codes count down, and after 5 the code is dead', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const code = lastCode()
    for (let left = 4; left >= 0; left--) {
      const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: wrong(code) })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_code', attemptsLeft: left })
    }
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code })
    expect(res.json()).toEqual({ error: 'code_expired' })
  })

  it('an expired code is rejected', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    await sql`update phone_otp_codes set expires_at = now() - interval '1 second'`
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.json()).toEqual({ error: 'code_expired' })
  })

  it('a malformed code is 400 invalid_code without using an attempt', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: '12' })
    expect(res.json()).toEqual({ error: 'invalid_code' })
    expect((await sql`select attempts from phone_otp_codes`)[0].attempts).toBe(0)
  })

  it('an earlier live code keeps working after a new request', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const first = lastCode()
    await ageCodes()
    await post(app, '/auth/phone/request', { phone: PHONE })
    expect((await post(app, '/auth/phone/verify', { phone: PHONE, code: first })).statusCode).toBe(200)
  })

  it('resend cooldown is 60 s', async () => {
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/request', { phone: PHONE })
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('resend_too_soon')
    expect(res.json().retryAfter).toBeGreaterThan(0)
    expect(sendOtpSms).toHaveBeenCalledTimes(1)
  })

  it('max 5 sends per phone per hour', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(app, '/auth/phone/request', { phone: PHONE })).statusCode).toBe(200)
      await ageCodes()
    }
    const res = await post(app, '/auth/phone/request', { phone: PHONE })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'too_many_requests' })
  })

  it('global daily cap answers 503', async () => {
    process.env.PHONE_OTP_DAILY_LIMIT = '1'
    try {
      await post(app, '/auth/phone/request', { phone: PHONE })
      const res = await post(app, '/auth/phone/request', { phone: '09121234568' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'phone_login_unavailable' })
    } finally {
      delete process.env.PHONE_OTP_DAILY_LIMIT
    }
  })

  it('a failed SMS send answers 502 and does not use up the quota', async () => {
    vi.mocked(sendOtpSms).mockResolvedValueOnce(false)
    const res = await post(app, '/auth/phone/request', { phone: PHONE })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'sms_send_failed' })
    expect((await sql`select count(*)::int as n from phone_otp_codes`)[0].n).toBe(0)
    expect((await post(app, '/auth/phone/request', { phone: PHONE })).statusCode).toBe(200)
  })

  it('production without a Mediana key answers 503 before sending', async () => {
    vi.mocked(isSmsConfigured).mockReturnValue(false)
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await post(app, '/auth/phone/request', { phone: PHONE })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'phone_login_unavailable' })
    } finally {
      process.env.NODE_ENV = env
    }
    expect(sendOtpSms).not.toHaveBeenCalled()
  })

  it('a banned account answers account_banned', async () => {
    await createUser({ phone: PHONE, banned_at: new Date().toISOString() })
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('account_banned')
  })

  it('a deleted account gives its phone up: login starts a fresh account', async () => {
    const old = await createUser({ telegram_id: null, phone: PHONE, deleted_at: new Date().toISOString() })
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.statusCode).toBe(200)
    expect(res.json().isNewUser).toBe(true)
    expect(res.json().user.id).not.toBe(old.id)
    expect((await sql`select phone from users where id = ${old.id}`)[0].phone).toBeNull()
  })

  it('a deleted AND banned account keeps its phone (no ban evasion)', async () => {
    const now = new Date().toISOString()
    await createUser({ phone: PHONE, deleted_at: now, banned_at: now })
    await post(app, '/auth/phone/request', { phone: PHONE })
    const res = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(res.json().error).toBe('account_banned')
  })
})

describe('add phone to a signed-in account', () => {
  let app: App
  let user: Record<string, any>
  let auth: Record<string, string>

  beforeEach(async () => {
    vi.mocked(sendOtpSms).mockResolvedValue(true)
    vi.mocked(isSmsConfigured).mockReturnValue(true)
    await resetDb()
    app = await buildApp()
    user = await createUser({ telegram_id: null, email: 'g@x.test', google_sub: 'g-1' })
    auth = { ...ANDROID, authorization: `Bearer ${signSessionToken(user.id)}` }
  })

  it('requires sign-in', async () => {
    const res = await post(app, '/auth/phone/link/request', { phone: PHONE })
    expect(res.statusCode).toBe(401)
  })

  it('links the phone to the current account; phone login then reaches it', async () => {
    expect((await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)).statusCode).toBe(200)
    expect((await sql`select user_id, purpose from phone_otp_codes`)[0]).toEqual({ user_id: user.id, purpose: 'link' })
    const res = await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ phone: PHONE })
    expect((await sql`select phone from users where id = ${user.id}`)[0].phone).toBe(PHONE)

    await ageCodes()
    await post(app, '/auth/phone/request', { phone: PHONE })
    const login = await post(app, '/auth/phone/verify', { phone: PHONE, code: lastCode() })
    expect(login.json().user.id).toBe(user.id)
  })

  it('refuses a phone owned by another account without sending an SMS', async () => {
    await createUser({ phone: PHONE })
    const res = await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'phone_in_use' })
    expect(sendOtpSms).not.toHaveBeenCalled()
  })

  it('answers phone_already_linked for its own phone', async () => {
    await sql`update users set phone = ${PHONE} where id = ${user.id}`
    const res = await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    expect(res.json()).toEqual({ error: 'phone_already_linked' })
  })

  it('takes a phone over from a deleted account', async () => {
    const old = await createUser({ telegram_id: null, phone: PHONE, deleted_at: new Date().toISOString() })
    await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    const res = await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect(res.statusCode).toBe(200)
    expect((await sql`select phone from users where id = ${old.id}`)[0].phone).toBeNull()
    expect((await sql`select phone from users where id = ${user.id}`)[0].phone).toBe(PHONE)
  })

  it('race: phone taken by another account between request and verify → 409', async () => {
    await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    await createUser({ phone: PHONE })
    const res = await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'phone_in_use' })
  })

  it('replaces an earlier phone', async () => {
    await sql`update users set phone = '09120000000' where id = ${user.id}`
    await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect((await sql`select phone from users where id = ${user.id}`)[0].phone).toBe(PHONE)
  })

  it('a link code cannot be used to log in, and a login code cannot link', async () => {
    await post(app, '/auth/phone/link/request', { phone: PHONE }, auth)
    const linkCode = lastCode()
    const login = await post(app, '/auth/phone/verify', { phone: PHONE, code: linkCode })
    expect(login.json()).toEqual({ error: 'code_expired' })

    await ageCodes()
    await post(app, '/auth/phone/request', { phone: PHONE })
    await sql`update phone_otp_codes set consumed_at = now() where purpose = 'link'`
    const link = await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect(link.json()).toEqual({ error: 'code_expired' })
  })

  it("another user's link code doesn't work for me", async () => {
    const other = await createUser({ telegram_id: null, email: 'o@x.test' })
    const otherAuth = { ...ANDROID, authorization: `Bearer ${signSessionToken(other.id)}` }
    await post(app, '/auth/phone/link/request', { phone: PHONE }, otherAuth)
    const res = await post(app, '/auth/phone/link/verify', { phone: PHONE, code: lastCode() }, auth)
    expect(res.json()).toEqual({ error: 'code_expired' })
  })

  it('/profile/me returns the phone to its owner', async () => {
    await sql`update users set phone = ${PHONE} where id = ${user.id}`
    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: auth })
    expect(res.json().phone).toBe(PHONE)
  })
})
