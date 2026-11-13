// Bazaar / Myket in-app purchase → premium grant.
//
// The Android app buys a premium SKU through the store's billing SDK and sends
// us the purchase token; we ask the store whether that token is a real,
// purchased item, then record the transaction and extend premium_until in one
// database transaction. The (provider, store_purchase_token) unique index
// guarantees a token grants premium at most once, even when the app retries
// concurrently. Purchase tokens are credentials: never log them.
import { sql } from '../db.js'
import { notifyPaymentChannel } from '../bot.js'
import { notifyUserPremiumPurchased } from '../notify/userNotify.js'
import { formatStorePaidNotice } from '../payments/paymentNotify.js'
import { isBazaarConfigured, verifyBazaarPurchase } from '../payments/bazaar.js'
import { isMyketConfigured, verifyMyketPurchase } from '../payments/myket.js'
import type { StoreName, StoreVerifyResult } from '../payments/storeTypes.js'
import { extendPremiumIn, type GrantUser } from './service.js'

export type StorePurchaseResult =
  | { ok: true; already: boolean; premiumUntil: string | null }
  | {
      error:
        | 'invalid_input' | 'unknown_sku' | 'token_used' | 'purchase_invalid' | 'payload_mismatch'
        | 'store_unavailable' | 'store_not_configured' | 'grant_failed'
    }

const MAX_FIELD_LENGTH = 256
const STORES: readonly StoreName[] = ['bazaar', 'myket']

const STORE_CLIENTS: Record<StoreName, {
  configured: () => boolean
  verify: (sku: string, token: string) => Promise<StoreVerifyResult>
}> = {
  bazaar: { configured: isBazaarConfigured, verify: verifyBazaarPurchase },
  myket: { configured: isMyketConfigured, verify: verifyMyketPurchase },
}

function cleanField(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= MAX_FIELD_LENGTH ? s : null
}

/** Validates the request fields: `store` allowlisted, sku/token strings that
 * are non-empty and ≤ 256 chars after trimming. Null when anything is off. */
export function normalizeStoreInput(
  store: unknown, sku: unknown, purchaseToken: unknown,
): { store: StoreName; sku: string; purchaseToken: string } | null {
  if (typeof store !== 'string' || !(STORES as readonly string[]).includes(store)) return null
  const cleanSku = cleanField(sku)
  const cleanToken = cleanField(purchaseToken)
  if (!cleanSku || !cleanToken) return null
  return { store: store as StoreName, sku: cleanSku, purchaseToken: cleanToken }
}

type StorePlan = { id: string; title: string; duration_days: number; price_toman: number | null }

/** A transaction already holds this token: the same buyer's paid row means the
 * app is retrying after a crash (answer success so it consumes); anything else
 * means the token belongs to someone else. Null when the token is unused. */
async function existingTokenResult(userId: string, store: StoreName, token: string): Promise<StorePurchaseResult | null> {
  const [row] = await sql<{ user_id: string; status: string }[]>`
    select user_id, status from premium_transactions
    where provider = ${store} and store_purchase_token = ${token}`
  if (!row) return null
  if (row.user_id !== userId || row.status !== 'paid') return { error: 'token_used' }
  const [u] = await sql<{ premium_until: string | null }[]>`select premium_until from users where id = ${userId}`
  return { ok: true, already: true, premiumUntil: u?.premium_until ?? null }
}

class GrantUserMissingError extends Error {}

export async function verifyStorePurchase(
  userId: string, store: StoreName, sku: string, purchaseToken: string,
): Promise<StorePurchaseResult> {
  const input = normalizeStoreInput(store, sku, purchaseToken)
  if (!input) return { error: 'invalid_input' }
  const client = STORE_CLIENTS[input.store]
  if (!client.configured()) return { error: 'store_not_configured' }

  // Checked before the plan lookup so an app retry of an already-granted
  // token still succeeds after an admin edits or clears the plan's SKU.
  const existing = await existingTokenResult(userId, input.store, input.purchaseToken)
  if (existing) return existing

  // Inactive plans still count: the user already paid for this SKU.
  const skuCol = input.store === 'bazaar' ? 'bazaar_sku' : 'myket_sku'
  const priceCol = input.store === 'bazaar' ? 'bazaar_price_toman' : 'myket_price_toman'
  const [plan] = await sql<StorePlan[]>`
    select id, title, duration_days, ${sql(priceCol)} as price_toman
    from premium_plans where ${sql(skuCol)} = ${input.sku}`
  if (!plan) return { error: 'unknown_sku' }

  let verified: StoreVerifyResult
  try {
    verified = await client.verify(input.sku, input.purchaseToken)
  } catch (err) {
    console.error(`[store-purchase] ${input.store} verify failed:`, (err as Error)?.message ?? err)
    return { error: 'store_unavailable' }
  }
  if (verified.status !== 'purchased') return { error: 'purchase_invalid' }
  if (verified.payload === null) {
    // Accepted: the token index still stops a second grant, and rejecting
    // would strand a buyer who has already paid.
    console.warn(`[store-purchase] ${input.store} purchase without developer payload accepted (user ${userId}, sku ${input.sku})`)
  } else if (verified.payload !== userId) {
    return { error: 'payload_mismatch' }
  }

  let granted: { premiumUntil: string; user: GrantUser } | null = null
  try {
    granted = await sql.begin(async (q) => {
      const [inserted] = await q`
        insert into premium_transactions (
          user_id, plan_id, plan_title, duration_days, price_stars, price_toman,
          provider, source, status, paid_at, store_sku, store_purchase_token
        ) values (
          ${userId}, ${plan.id}, ${plan.title}, ${plan.duration_days}, 0, ${plan.price_toman},
          ${input.store}, 'purchase', 'paid', now(), ${input.sku}, ${input.purchaseToken}
        )
        on conflict (provider, store_purchase_token) where store_purchase_token is not null do nothing
        returning id`
      if (!inserted) return null // a concurrent request recorded this token first
      const res = await extendPremiumIn(q, userId, plan.duration_days)
      if (!res) throw new GrantUserMissingError('user not found')
      return res
    })
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') {
      // Lost a race on the token index: answer like a resubmit.
      console.warn(`[store-purchase] ${input.store} unique violation on grant (user ${userId}, sku ${input.sku}): ${(err as Error)?.message ?? err}`)
      granted = null
    } else {
      console.error(`[store-purchase] ${input.store} grant failed (user ${userId}):`, (err as Error)?.message ?? err)
      return { error: 'grant_failed' }
    }
  }

  if (!granted) {
    return (await existingTokenResult(userId, input.store, input.purchaseToken)) ?? { error: 'grant_failed' }
  }

  const { user, premiumUntil } = granted
  notifyPaymentChannel(formatStorePaidNotice({
    store: input.store,
    buyerName: user.name ?? null,
    durationDays: plan.duration_days,
    sku: input.sku,
    amountToman: plan.price_toman,
    at: new Date().toISOString(),
  })).catch(() => {})
  notifyUserPremiumPurchased(
    { id: userId, telegram_id: user.telegram_id, allows_write_to_pm: user.allows_write_to_pm, locale: user.locale },
    plan.duration_days,
  ).catch((err) => console.error('[store-purchase] buyer notification failed:', err?.message ?? err))

  return { ok: true, already: false, premiumUntil }
}
