import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { cityKey, parseGeo, askDeepSeek, resolveCity, updateUserGeo, scheduleUserGeo } from '../src/geo/resolveCity.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { withFailingWrites, withMissingTable } from './helpers/profile.js'

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
  beforeEach(async () => {
    await resetDb()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns a cached spelling without calling DeepSeek', async () => {
    await insertRow('city_lookups', { key: 'tehran', city: 'Tehran', country: 'IR' })

    await expect(resolveCity('  TEHRAN ')).resolves.toEqual({ city: 'Tehran', country: 'IR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks DeepSeek on a cache miss and caches the answer, including "not a place"', async () => {
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"city":null,"country":null}'))

    await expect(resolveCity('asdfgh')).resolves.toEqual({ city: null, country: null })
    expect(await sql`select key, city, country from city_lookups`).toEqual([
      { key: 'asdfgh', city: null, country: null },
    ])
    // Second lookup is a cache hit.
    await expect(resolveCity('ASDFGH')).resolves.toEqual({ city: null, country: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache when DeepSeek fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(resolveCity('Tehran')).rejects.toThrow('network down')
    expect((await sql`select count(*)::int as n from city_lookups`)[0].n).toBe(0)
  })

  it('treats a failed cache read as a miss and ignores a failed cache write', async () => {
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"city":"Tehran","country":"IR"}'))
    await withMissingTable('city_lookups', () =>
      expect(resolveCity('Tehran')).resolves.toEqual({ city: 'Tehran', country: 'IR' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('updateUserGeo', () => {
  const fetchMock = vi.fn()
  beforeEach(async () => {
    await resetDb()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('writes geo only while the user still has the same typed location', async () => {
    await insertRow('city_lookups', { key: 'تهران', city: 'Tehran', country: 'IR' })
    const same = await createUser({ location: 'تهران' })
    const moved = await createUser({ location: 'مشهد' })

    await expect(updateUserGeo(same.id, 'تهران')).resolves.toEqual({ city: 'Tehran', country: 'IR' })
    await updateUserGeo(moved.id, 'تهران')

    const rows = await sql`select id, geo_city, geo_country from users order by created_at`
    expect(rows.find((r) => r.id === same.id)).toMatchObject({ geo_city: 'Tehran', geo_country: 'IR' })
    expect(rows.find((r) => r.id === moved.id)).toMatchObject({ geo_city: null, geo_country: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws geo_update_failed when the write fails', async () => {
    await insertRow('city_lookups', { key: 'tehran', city: 'Tehran', country: 'IR' })
    const u = await createUser({ location: 'Tehran' })
    await withFailingWrites('users', 'update', () =>
      expect(updateUserGeo(u.id, 'Tehran')).rejects.toThrow('geo_update_failed'))
  })
})

describe('scheduleUserGeo', () => {
  const log = { warn: vi.fn() } as any
  const fetchMock = vi.fn()
  beforeEach(async () => {
    await resetDb()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('is a no-op without DEEPSEEK_API_KEY', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const u = await createUser({ location: 'Tehran' })
    scheduleUserGeo(u.id, 'Tehran', log)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await sql`select count(*)::int as n from city_lookups`)[0].n).toBe(0)
  })

  it('is a no-op for an empty location', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    scheduleUserGeo('u1', '  ', log)
    scheduleUserGeo('u1', null, log)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs instead of throwing when resolution fails', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    fetchMock.mockRejectedValue(new Error('network down'))
    const u = await createUser({ location: 'Tehran' })

    scheduleUserGeo(u.id, 'Tehran', log)
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled())
  })
})
