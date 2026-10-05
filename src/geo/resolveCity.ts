import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db.js'

// Hidden, normalized location for the discovery ranking. Never sent to clients.
export type Geo = { city: string | null; country: string | null }

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'
const TIMEOUT_MS = 15_000
const MAX_CITY_LENGTH = 80

const SYSTEM_PROMPT = `You normalize the city a dating-app user typed as where they live.
The input may be in Persian, Arabic, English or any other language, transliterated, misspelled, or include a province or neighborhood.
Reply with a JSON object only, exactly: {"city": string | null, "country": string | null}
- city: the city's common English name, e.g. "Tehran", "Mashhad", "Dubai". For a neighborhood or district, return the city it belongs to. If a name is ambiguous, pick the most populous match.
- country: ISO 3166-1 alpha-2 code in uppercase, e.g. "IR", "AE", "DE".
- If only a country is given, return city null and the country code.
- If the input is not a recognizable place, return {"city": null, "country": null}.`

const NONE: Geo = { city: null, country: null }

/** Cache key: one row per distinct spelling, ignoring case and extra spaces. */
export function cityKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Validates the model's JSON reply. Throws on non-JSON (a transient model
 * failure, so it must not be cached); malformed fields degrade to null. A city
 * without a valid country is dropped — the tiers match city within country.
 */
export function parseGeo(content: string): Geo {
  const parsed = JSON.parse(content) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') return NONE

  const country =
    typeof parsed.country === 'string' && /^[A-Za-z]{2}$/.test(parsed.country.trim())
      ? parsed.country.trim().toUpperCase()
      : null
  if (!country) return NONE

  const cityRaw = typeof parsed.city === 'string' ? parsed.city.trim() : ''
  const city = cityRaw.length > 0 && cityRaw.length <= MAX_CITY_LENGTH ? cityRaw : null
  return { city, country }
}

/** One DeepSeek call. Throws on network/API/parse failure. */
export async function askDeepSeek(raw: string): Promise<Geo> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: raw.trim() },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`deepseek_http_${res.status}`)

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('deepseek_empty_reply')
  return parseGeo(content)
}

/** Cache-first resolution of a typed city. Throws only when DeepSeek fails. */
export async function resolveCity(raw: string): Promise<Geo> {
  const key = cityKey(raw)
  if (!key) return NONE

  const { data: cached } = await db
    .from('city_lookups')
    .select('city, country')
    .eq('key', key)
    .maybeSingle()
  if (cached) return { city: cached.city ?? null, country: cached.country ?? null }

  const geo = await askDeepSeek(raw)
  await db.from('city_lookups').upsert({ key, city: geo.city, country: geo.country })
  return geo
}

/**
 * Resolves `location` and stores it on the user. The `.eq('location', …)`
 * guard drops a stale result if the user changed city while this ran.
 */
export async function updateUserGeo(userId: string, location: string): Promise<Geo> {
  const geo = await resolveCity(location)
  const { error } = await db
    .from('users')
    .update({ geo_city: geo.city, geo_country: geo.country })
    .eq('id', userId)
    .eq('location', location)
  if (error) throw new Error(`geo_update_failed: ${error.message}`)
  return geo
}

/**
 * Fire-and-forget: a profile save must never wait on, or fail because of,
 * DeepSeek. No-op without DEEPSEEK_API_KEY (feature off).
 */
export function scheduleUserGeo(userId: string, location: string | null, log: FastifyBaseLogger): void {
  if (!process.env.DEEPSEEK_API_KEY || !location?.trim()) return
  updateUserGeo(userId, location).catch((err) => {
    log.warn({ err, userId }, 'city geo resolution failed')
  })
}
