import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendOtpSms } from '../src/phone/mediana.js'

const log = { warn: vi.fn() } as any

describe('sendOtpSms', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.MEDIANA_API_KEY
  })

  it('sends the code to the OTP endpoint with the pattern code', async () => {
    process.env.MEDIANA_API_KEY = 'k'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ meta: { code: 'OK' }, data: { succeed: true } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await sendOtpSms('09121234567', '48213', log)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.mediana.ir/sms/v1/send/otp')
    expect(init.headers).toMatchObject({ 'X-API-KEY': 'k' })
    expect(JSON.parse(init.body)).toEqual({
      patternCode: '815518', recipient: '09121234567', otpCode: '48213',
    })
  })

  it('false on a non-2xx, an unsuccessful body or a network error', async () => {
    process.env.MEDIANA_API_KEY = 'k'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))
    expect(await sendOtpSms('09121234567', '1', log)).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { succeed: false } }))))
    expect(await sendOtpSms('09121234567', '1', log)).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    expect(await sendOtpSms('09121234567', '1', log)).toBe(false)
  })
})
