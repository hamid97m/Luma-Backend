import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendOtpSms } from '../src/phone/mediana.js'

const log = { warn: vi.fn() } as any

describe('sendOtpSms', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.MEDIANA_API_KEY
  })

  it('sends the pattern with the code in its `otp` placeholder', async () => {
    process.env.MEDIANA_API_KEY = 'k'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ meta: { code: 'OK' }, data: { succeed: true } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await sendOtpSms('09121234567', '48213', log)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.mediana.ir/sms/v1/send/pattern')
    expect(init.headers).toMatchObject({ 'X-API-KEY': 'k' })
    expect(JSON.parse(init.body)).toEqual({
      type: 'Informational', patternCode: '815518', recipients: ['09121234567'], parameters: { otp: '48213' },
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
