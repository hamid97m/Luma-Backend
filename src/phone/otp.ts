import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db.js'
import { sendOtpSms } from './mediana.js'
import { normalizeIranMobile } from './normalize.js'

export type OtpPurpose = 'login' | 'link'

export const CODE_TTL_SECONDS = 120
export const RESEND_COOLDOWN_SECONDS = 60
export const MAX_ATTEMPTS = 5
const SENDS_PER_PHONE_PER_HOUR = 5
const SENDS_PER_USER_PER_HOUR = 5
// Sends, not requests: many Iranian mobile users share one carrier-NAT address.
const SENDS_PER_IP_PER_HOUR = 30
const DEFAULT_DAILY_LIMIT = 2000

type Fail = { ok: false; status: number; body: Record<string, unknown> }

function hashCode(code: string): string {
  return createHmac('sha256', process.env.USER_JWT_SECRET ?? '').update(code).digest('hex')
}

function dailyLimit(): number {
  const n = Number(process.env.PHONE_OTP_DAILY_LIMIT)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT
}

/** Persian/Arabic digits → Latin; null unless exactly 5 digits. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  return /^\d{5}$/.test(s) ? s : null
}

/** Test numbers (store review, QA, SMS-provider outages) get PHONE_OTP_STATIC_CODE
 *  and no SMS. Only numbers listed in PHONE_OTP_STATIC_NUMBERS — never everyone,
 *  which would let anyone sign in as any number. */
export function staticCodeFor(phone: string): string | null {
  const code = normalizeCode(process.env.PHONE_OTP_STATIC_CODE ?? '')
  if (!code) return null
  const numbers = (process.env.PHONE_OTP_STATIC_NUMBERS ?? '').split(',').map(normalizeIranMobile)
  return numbers.includes(phone) ? code : null
}

/** Checks the send limits, stores a new code and sends it by SMS. A failed send
 *  deletes its row, so a provider outage doesn't use up the user's quota. */
export async function issueCode(opts: {
  phone: string; purpose: OtpPurpose; userId: string | null; ip: string; log: FastifyBaseLogger
}): Promise<{ ok: true } | Fail> {
  const { phone, purpose, userId, ip, log } = opts
  const staticCode = staticCodeFor(phone)
  const code = staticCode ?? String(randomInt(0, 100_000)).padStart(5, '0')

  // Serialized per phone so two parallel requests can't both pass the cooldown.
  const issued = await sql.begin(async (tx): Promise<{ id: string } | Fail> => {
    await tx`select pg_advisory_xact_lock(hashtext(${'phone_otp:' + phone}))`

    const [last] = await tx<{ age: number }[]>`
      select extract(epoch from now() - created_at)::float8 as age
      from phone_otp_codes where phone = ${phone}
      order by created_at desc limit 1`
    if (last && last.age < RESEND_COOLDOWN_SECONDS) {
      const retryAfter = Math.max(1, Math.ceil(RESEND_COOLDOWN_SECONDS - last.age))
      return { ok: false, status: 429, body: { error: 'resend_too_soon', retryAfter } }
    }

    const [{ n: perPhone }] = await tx<{ n: number }[]>`
      select count(*)::int as n from phone_otp_codes
      where phone = ${phone} and created_at > now() - interval '1 hour'`
    if (perPhone >= SENDS_PER_PHONE_PER_HOUR) {
      return { ok: false, status: 429, body: { error: 'too_many_requests' } }
    }

    if (userId) {
      const [{ n: perUser }] = await tx<{ n: number }[]>`
        select count(*)::int as n from phone_otp_codes
        where user_id = ${userId} and created_at > now() - interval '1 hour'`
      if (perUser >= SENDS_PER_USER_PER_HOUR) {
        return { ok: false, status: 429, body: { error: 'too_many_requests' } }
      }
    }

    const [{ n: perIp }] = await tx<{ n: number }[]>`
      select count(*)::int as n from phone_otp_codes
      where ip = ${ip} and created_at > now() - interval '1 hour'`
    if (perIp >= SENDS_PER_IP_PER_HOUR) {
      return { ok: false, status: 429, body: { error: 'too_many_requests' } }
    }

    const [{ n: today }] = await tx<{ n: number }[]>`
      select count(*)::int as n from phone_otp_codes
      where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`
    if (today >= dailyLimit()) {
      log.error({ limit: dailyLimit() }, 'phone OTP daily limit reached')
      return { ok: false, status: 503, body: { error: 'phone_login_unavailable' } }
    }

    const [row] = await tx<{ id: string }[]>`
      insert into phone_otp_codes ${tx({
        phone, purpose, user_id: userId, code_hash: hashCode(code), ip,
        expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
      })}
      returning id`
    return row
  })
  if ('ok' in issued) return issued

  if (!staticCode && !(await sendOtpSms(phone, code, log))) {
    await sql`delete from phone_otp_codes where id = ${issued.id}`
    return { ok: false, status: 502, body: { error: 'sms_send_failed' } }
  }

  // Older live codes stay valid: someone requesting codes for a number they
  // don't own must not cancel the code its owner is about to type.
  return { ok: true }
}

/** Checks a code against the live codes for phone+purpose (and, for 'link',
 *  the requesting user) and consumes the matching one. A wrong guess counts
 *  against every live code, so extra live codes don't buy extra guesses. */
export async function verifyCode(opts: {
  phone: string; purpose: OtpPurpose; userId: string | null; code: string
}): Promise<{ ok: true } | Fail> {
  const { phone, purpose, userId, code } = opts
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; code_hash: string; attempts: number }[]>`
      select id, code_hash, attempts
      from phone_otp_codes
      where phone = ${phone} and purpose = ${purpose} and consumed_at is null
        and expires_at > now() and attempts < ${MAX_ATTEMPTS}
        and ${userId ? tx`user_id = ${userId}` : tx`user_id is null`}
      order by created_at desc
      for update`
    if (!rows.length) return { ok: false, status: 400, body: { error: 'code_expired' } } as Fail

    const given = Buffer.from(hashCode(code), 'hex')
    const match = rows.find((r) => timingSafeEqual(Buffer.from(r.code_hash, 'hex'), given))
    if (!match) {
      const ids = rows.map((r) => r.id)
      await tx`update phone_otp_codes set attempts = attempts + 1 where id in ${tx(ids)}`
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - (Math.max(...rows.map((r) => r.attempts)) + 1))
      return { ok: false, status: 400, body: { error: 'invalid_code', attemptsLeft } } as Fail
    }

    await tx`update phone_otp_codes set consumed_at = now() where id = ${match.id}`
    return { ok: true } as const
  })
}
