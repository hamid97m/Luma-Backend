// Shared types for app-store (Cafe Bazaar / Myket) purchase verification.

export type StoreName = 'bazaar' | 'myket'

export type StoreVerifyResult =
  | { status: 'purchased'; payload: string | null; purchaseTime: number | null }
  | { status: 'invalid' }

/** Network error, timeout, 5xx or auth failure talking to the store. */
export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreUnavailableError'
  }
}

export const STORE_TIMEOUT_MS = 10_000

/** Maps a Google-Play-style purchase body to a verify result. */
export function parsePurchaseBody(body: unknown, expectedSku: string): StoreVerifyResult {
  const b = (body ?? {}) as Record<string, unknown>
  if (b.purchaseState !== 0) return { status: 'invalid' }
  // Defense in depth: if the store names a product, it must be the one we asked about.
  for (const k of ['productId', 'sku']) {
    const v = b[k]
    if (typeof v === 'string' && v !== '' && v !== expectedSku) return { status: 'invalid' }
  }
  const payload = typeof b.developerPayload === 'string' && b.developerPayload !== '' ? b.developerPayload : null
  const purchaseTime = typeof b.purchaseTime === 'number' ? b.purchaseTime : null
  return { status: 'purchased', payload, purchaseTime }
}
