// Cafe Bazaar in-app purchase verification (server-to-server, developer API v2).
// Endpoints confirmed against a working Go client; access token sent as a Bearer header.
import { StoreUnavailableError, STORE_TIMEOUT_MS, parsePurchaseBody, type StoreVerifyResult } from './storeTypes.js'

const BASE = 'https://pardakht.cafebazaar.ir/devapi/v2'
const REFRESH_MARGIN_MS = 60_000

let cached: { token: string; expiresAt: number } | null = null

export function _resetBazaarTokenCache(): void {
  cached = null
}

export function isBazaarConfigured(): boolean {
  return !!(process.env.BAZAAR_CLIENT_ID && process.env.BAZAAR_CLIENT_SECRET && process.env.BAZAAR_REFRESH_TOKEN)
}

async function getAccessToken(forceRefresh: boolean): Promise<string> {
  if (!forceRefresh && cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token
  let res: Response
  try {
    res = await fetch(`${BASE}/auth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.BAZAAR_CLIENT_ID ?? '',
        client_secret: process.env.BAZAAR_CLIENT_SECRET ?? '',
        refresh_token: process.env.BAZAAR_REFRESH_TOKEN ?? '',
      }).toString(),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    })
  } catch (err) {
    throw new StoreUnavailableError(`bazaar token request failed: ${(err as Error).message}`)
  }
  if (!res.ok) throw new StoreUnavailableError(`bazaar token endpoint responded ${res.status}`)
  let body: { access_token?: unknown; expires_in?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new StoreUnavailableError('bazaar token endpoint returned a non-JSON body')
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new StoreUnavailableError('bazaar token endpoint returned no access_token')
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  cached = { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 }
  return cached.token
}

async function validate(sku: string, token: string, access: string): Promise<Response> {
  const pkg = process.env.BAZAAR_PACKAGE_NAME || 'com.lumi'
  const url =
    `${BASE}/api/validate/${encodeURIComponent(pkg)}/inapp/${encodeURIComponent(sku)}` +
    `/purchases/${encodeURIComponent(token)}/`
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(STORE_TIMEOUT_MS) })
  } catch (err) {
    throw new StoreUnavailableError(`bazaar request failed: ${(err as Error).message}`)
  }
}

export async function verifyBazaarPurchase(sku: string, token: string): Promise<StoreVerifyResult> {
  let res = await validate(sku, token, await getAccessToken(false))
  if (res.status === 401) {
    res = await validate(sku, token, await getAccessToken(true))
    if (res.status === 401) throw new StoreUnavailableError('bazaar rejected the refreshed access token')
  }
  if (res.status === 404) return { status: 'invalid' }
  if (!res.ok) throw new StoreUnavailableError(`bazaar responded ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new StoreUnavailableError('bazaar returned a non-JSON body')
  }
  return parsePurchaseBody(body)
}
