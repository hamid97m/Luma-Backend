import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { db } from '../src/db.js'
import { cityKey, parseGeo, askDeepSeek, resolveCity, updateUserGeo, scheduleUserGeo } from '../src/geo/resolveCity.js'
import { chainable } from './admin-helpers.js'

function deepSeekReply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
}

describe('cityKey', () => {
  it('ignores case and extra whitespace', () => {
    expect(cityKey('  New   York ')).toBe('new york')
    expect(cityKey(' تهران ')).toBe('تهران')
  })
})

describe('parseGeo', () => {
  it('accepts a city with an ISO country code', () => {
    expect(parseGeo('{"city":"Tehran","country":"ir"}')).toEqual({ city: 'Tehran', country: 'IR' })
  })

  it('accepts a country-only answer', () => {
    expect(parseGeo('{"city":null,"country":"DE"}')).toEqual({ city: null, country: 'DE' })
  })

  it('drops a city that comes without a valid country', () => {
    expect(parseGeo('{"city":"Tehran","country":"Iran"}')).toEqual({ city: null, country: null })
    expect(parseGeo('{"city":"Tehran"}')).toEqual({ city: null, country: null })
  })

  it('maps "not a place" to nulls', () => {
    expect(parseGeo('{"city":null,"country":null}')).toEqual({ city: null, country: null })
  })

  it('throws on non-JSON so the failure is not cached', () => {
    expect(() => parseGeo('Tehran, Iran')).toThrow()
  })
})

describe('askDeepSeek', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('sends the typed city in JSON mode with the bearer key', async () => {
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"city":"Mashhad","country":"IR"}'))

    await expect(askDeepSeek(' مشهد ')).resolves.toEqual({ city: 'Mashhad', country: 'IR' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.response_format).toEqual({ type: 'json_object' })
    // thinking mode bills hidden reasoning tokens — must stay off
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'مشهد' })
  })

  it('throws on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    await expect(askDeepSeek('Tehran')).rejects.toThrow('deepseek_http_503')
  })

  it('stops calling DeepSeek once the daily limit is spent, and resets the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'))
    vi.stubEnv('DEEPSEEK_DAILY_LIMIT', '2')
    fetchMock.mockImplementation(async () => deepSeekReply('{"city":"Tehran","country":"IR"}'))

    await askDeepSeek('a')
    await askDeepSeek('b')
    await expect(askDeepSeek('c')).rejects.toThrow('deepseek_daily_limit')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date('2030-01-02T00:00:01Z'))
    await expect(askDeepSeek('c')).resolves.toEqual({ city: 'Tehran', country: 'IR' })
    vi.useRealTimers()
  })

  it('throws without an API key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await expect(askDeepSeek('Tehran')).rejects.toThrow('DEEPSEEK_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveCity', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns a cached spelling without calling DeepSeek', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: { city: 'Tehran', country: 'IR' }, error: null }, log))

    await expect(resolveCity('  TEHRAN ')).resolves.toEqual({ city: 'Tehran', country: 'IR' })
    expect(log).toContainEqual({ method: 'eq', args: ['key', 'tehran'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks DeepSeek on a cache miss and caches the answer, including "not a place"', async () => {
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: null, error: null }))
    const upsert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.from).mockReturnValueOnce({ upsert } as any)
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"city":null,"country":null}'))

    await expect(resolveCity('asdfgh')).resolves.toEqual({ city: null, country: null })
    expect(upsert).toHaveBeenCalledWith({ key: 'asdfgh', city: null, country: null })
  })

  it('does not cache when DeepSeek fails', async () => {
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: null, error: null }))
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(resolveCity('Tehran')).rejects.toThrow('network down')
    expect(db.from).toHaveBeenCalledTimes(1)
  })
})

describe('updateUserGeo', () => {
  it('writes geo only while the user still has the same typed location', async () => {
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: { city: 'Tehran', country: 'IR' }, error: null }))
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ error: null }, log))

    await updateUserGeo('u1', 'تهران')

    expect(log).toEqual([
      { method: 'update', args: [{ geo_city: 'Tehran', geo_country: 'IR' }] },
      { method: 'eq', args: ['id', 'u1'] },
      { method: 'eq', args: ['location', 'تهران'] },
    ])
  })
})

describe('scheduleUserGeo', () => {
  const log = { warn: vi.fn() } as any
  afterEach(() => vi.unstubAllEnvs())

  it('is a no-op without DEEPSEEK_API_KEY', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    scheduleUserGeo('u1', 'Tehran', log)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty location', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    scheduleUserGeo('u1', '  ', log)
    scheduleUserGeo('u1', null, log)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('logs instead of throwing when resolution fails', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: null, error: null }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    scheduleUserGeo('u1', 'Tehran', log)
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled())
    vi.unstubAllGlobals()
  })
})
