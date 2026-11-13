// Myket in-app purchase verification (server-to-server).
import { StoreUnavailableError, STORE_TIMEOUT_MS, parsePurchaseBody, type StoreVerifyResult } from './storeTypes.js'

export function isMyketConfigured(): boolean {
  return !!process.env.MYKET_ACCESS_TOKEN
}

export async function verifyMyketPurchase(sku: string, token: string): Promise<StoreVerifyResult> {
  const pkg = process.env.MYKET_PACKAGE_NAME || 'com.lumi'
  const url =
    `https://developer.myket.ir/api/applications/${encodeURIComponent(pkg)}` +
    `/purchases/products/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(token)}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-Access-Token': process.env.MYKET_ACCESS_TOKEN ?? '' },
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    })
  } catch (err) {
    throw new StoreUnavailableError(`myket request failed: ${(err as Error).message}`)
  }
  if (res.status === 404) return { status: 'invalid' }
  if (!res.ok) throw new StoreUnavailableError(`myket responded ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new StoreUnavailableError('myket returned a non-JSON body')
  }
  return parsePurchaseBody(body)
}
