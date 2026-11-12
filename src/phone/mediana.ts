import type { FastifyBaseLogger } from 'fastify'

const MEDIANA_OTP_URL = 'https://api.mediana.ir/sms/v1/send/otp'
const DEFAULT_PATTERN_CODE = '815518'
const TIMEOUT_MS = 10_000

export function isSmsConfigured(): boolean {
  return Boolean(process.env.MEDIANA_API_KEY)
}

/** Sends the code through Mediana's OTP pattern. Never throws; true = accepted.
 *  Without MEDIANA_API_KEY outside production the code is only logged (dev). */
export async function sendOtpSms(phone: string, code: string, log: FastifyBaseLogger): Promise<boolean> {
  const apiKey = process.env.MEDIANA_API_KEY
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') return false
    log.warn({ phone, code }, 'MEDIANA_API_KEY unset: OTP not sent (dev)')
    return true
  }
  try {
    const res = await fetch(MEDIANA_OTP_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patternCode: process.env.MEDIANA_OTP_PATTERN_CODE || DEFAULT_PATTERN_CODE,
        recipient: phone,
        otpCode: code,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as
      | { meta?: { requestId?: string; code?: string; errorMessage?: string | null }; data?: { succeed?: boolean; requestId?: number } }
      | null
    if (res.ok && body?.data?.succeed === true) return true
    // Never log the code or the key.
    log.warn(
      { status: res.status, metaCode: body?.meta?.code, error: body?.meta?.errorMessage, requestId: body?.meta?.requestId },
      'Mediana OTP send failed',
    )
    return false
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Mediana OTP send error')
    return false
  }
}
