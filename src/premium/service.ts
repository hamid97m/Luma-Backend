import { db } from '../db.js'
import { createPremiumInvoiceLink, refundPremiumPayment, notifyPaymentChannel, notifyPremiumPurchased } from '../bot.js'
import { formatPremiumPaidNotice } from '../payments/paymentNotify.js'
import { schedulePurchaseCheckoutFollowup } from '../jobs/purchaseMessage.js'
import { tFor, type Locale } from '../i18n/index.js'
import {
  isTonPaysConfigured, createTelegramInvoice, checkInvoice, cancelInvoice,
  generateTonPaysOrderId, TonPaysApiError, type TonPaysInvoice,
} from '../payments/tonpays.js'

export const PREMIUM_PAYLOAD_PREFIX = 'premium:'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TOMAN_PER_STAR = 3000

export type PaymentProvider = 'stars' | 'tonpays'

export type PlanTranslations = Partial<Record<'en' | 'ar', { title?: string; description?: string }>>

/** Plan title/description for a locale. Persian columns are the base; a
 * translation overrides field-by-field, blank strings fall back. */
export function planText(
  plan: { title: string; description: string; translations?: PlanTranslations | null },
  locale: Locale | null,
): { title: string; description: string } {
  const tr = locale && locale !== 'fa' ? plan.translations?.[locale] : undefined
  return {
    title: tr?.title?.trim() || plan.title,
    description: tr?.description?.trim() || plan.description,
  }
}

export function isPremiumActive(premiumUntil: string | null, nowMs = Date.now()): boolean {
  return !!premiumUntil && new Date(premiumUntil).getTime() > nowMs
}

/** New expiry after adding `durationDays`: extends from the later of now / current expiry,
 * so stacked purchases add up instead of overwriting. */
export function extendPremiumUntil(current: string | null, durationDays: number, nowMs = Date.now()): string {
  const currentMs = current ? new Date(current).getTime() : 0
  const base = currentMs > nowMs ? currentMs : nowMs
  return new Date(base + durationDays * DAY_MS).toISOString()
}

/** A plan's discount is in effect when a percent is set and (no deadline, or the deadline hasn't passed). */
export function discountActive(
  discountPercent: number | null | undefined,
  discountEndsAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!discountPercent) return false
  if (!discountEndsAt) return true
  return new Date(discountEndsAt).getTime() > nowMs
}

/** Charged price for an active discount: full price minus the percent, floored at 1 star
 * (Telegram invoices require an amount >= 1). */
export function chargedPrice(priceStars: number, discountPercent: number): number {
  return Math.max(1, Math.round(priceStars * (1 - discountPercent / 100)))
}

export async function isPremiumEnabled(): Promise<boolean> {
  const { data } = await db.from('premium_config').select('premium_enabled').eq('id', true).single()
  return data?.premium_enabled === true
}

/** Iranian users pay via TonPays (card-to-card) when it's configured; everyone
 * else keeps paying with Telegram Stars. */
export function resolvePaymentProvider(geoCountry: string | null | undefined): PaymentProvider {
  return geoCountry === 'IR' && isTonPaysConfigured() ? 'tonpays' : 'stars'
}

/** Toman-per-Star conversion rate, admin-configurable; falls back to 3000 if
 * the config row or column isn't there. */
export async function getTomanPerStar(): Promise<number> {
  const { data } = await db.from('premium_config').select('toman_per_star').eq('id', true).single()
  return (data?.toman_per_star as number | null | undefined) ?? DEFAULT_TOMAN_PER_STAR
}

export async function getPremiumStatus(userId: string) {
  const [{ data: cfg }, { data: me }, { data: plans }] = await Promise.all([
    db.from('premium_config').select('premium_enabled').eq('id', true).single(),
    db.from('users').select('premium_until, locale, geo_country').eq('id', userId).single(),
    db.from('premium_plans')
      .select('id, title, description, translations, price_stars, discount_percent, discount_ends_at, duration_days')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
  ])
  const locale = (me?.locale as Locale | null) ?? null
  const paymentProvider = resolvePaymentProvider(me?.geo_country ?? null)
  const tomanPerStar = paymentProvider === 'tonpays' ? await getTomanPerStar() : null

  return {
    enabled: cfg?.premium_enabled === true,
    premiumUntil: me?.premium_until ?? null,
    paymentProvider,
    plans: (plans ?? []).map((p: any) => {
      const active = discountActive(p.discount_percent, p.discount_ends_at)
      const text = planText(p, locale)
      const priceStars = active ? chargedPrice(p.price_stars, p.discount_percent) : p.price_stars
      const originalPriceStars = active ? p.price_stars : null
      const base = {
        id: p.id,
        title: text.title,
        description: text.description,
        priceStars,
        originalPriceStars,
        discountPercent: active ? p.discount_percent : null,
        discountEndsAt: active ? (p.discount_ends_at ?? null) : null,
        durationDays: p.duration_days,
      }
      if (tomanPerStar == null) return base
      return {
        ...base,
        priceToman: priceStars * tomanPerStar,
        originalPriceToman: originalPriceStars != null ? originalPriceStars * tomanPerStar : null,
      }
    }),
  }
}

export type PremiumCheckoutResult =
  | { error: string }
  | { transactionId: string; provider: 'stars'; invoiceLink: string }
  | { transactionId: string; provider: 'tonpays'; payment: { cardNumber: string; cardHolder: string; amountToman: number; invoiceId: string } }

export async function createPremiumCheckout(userId: string, planId: string): Promise<PremiumCheckoutResult> {
  if (!(await isPremiumEnabled())) return { error: 'premium_disabled' }

  const { data: plan } = await db
    .from('premium_plans')
    .select('id, title, description, translations, price_stars, discount_percent, discount_ends_at, duration_days')
    .eq('id', planId).eq('is_active', true)
    .maybeSingle()
  if (!plan) return { error: 'plan_unavailable' }

  // Invoice copy follows the buyer's language; geo_country decides the payment
  // provider and, for TonPays, telegram_id is who the invoice is addressed to.
  const { data: buyer } = await db.from('users').select('locale, geo_country, telegram_id').eq('id', userId).maybeSingle()
  const locale = (buyer?.locale as Locale | null) ?? null
  const text = planText(plan, locale)
  const t = tFor(locale)

  // Recompute the discount at checkout time (not what was shown when the paywall loaded) and
  // snapshot the charged amount — an invoice created seconds before expiry is still honored later.
  const chargeStars = discountActive(plan.discount_percent, plan.discount_ends_at)
    ? chargedPrice(plan.price_stars, plan.discount_percent)
    : plan.price_stars

  if (resolvePaymentProvider(buyer?.geo_country ?? null) === 'tonpays') {
    return createTonPaysCheckout(userId, plan, text.title, chargeStars, (buyer?.telegram_id as number | null) ?? 0)
  }

  const { data: tx, error } = await db.from('premium_transactions').insert({
    user_id: userId, plan_id: plan.id, plan_title: text.title,
    price_stars: chargeStars, duration_days: plan.duration_days,
    status: 'pending_payment', source: 'purchase',
  }).select('id').single()
  if (error || !tx) return { error: 'checkout_failed' }

  const invoiceLink = await createPremiumInvoiceLink(
    tx.id, text.title, text.description || t.premium.invoiceDescriptionFallback(plan.duration_days), chargeStars,
  )

  // Per-payment abandoned-checkout nudge: check back in ~5 min and, if this is
  // still unpaid and the user has never been messaged, DM them once. Cheap
  // fire-and-forget; the periodic backstop sweep covers checks lost to a restart.
  schedulePurchaseCheckoutFollowup(userId)

  return { transactionId: tx.id, provider: 'stars', invoiceLink }
}

/**
 * TonPays branch of checkout: snapshot `price_toman` at the live rate, insert a
 * pending row, then ask TonPays for a card-to-card invoice.
 *
 * `BUYER_HAS_PENDING_INVOICE` means this buyer already has a live invoice at
 * TonPays (one per buyer, not per order): if it's for the same plan and the
 * same charged amount, resume it (the new, never-invoiced row we just inserted
 * is dropped instead of left dangling); otherwise cancel the stale one and
 * retry creation exactly once. Any other failure cancels the new row and
 * reports `checkout_failed`.
 */
async function createTonPaysCheckout(
  userId: string,
  plan: { id: string; duration_days: number },
  planTitle: string,
  chargeStars: number,
  buyerChatId: number,
): Promise<PremiumCheckoutResult> {
  const priceToman = chargeStars * (await getTomanPerStar())
  const orderId = generateTonPaysOrderId()

  const { data: tx, error } = await db.from('premium_transactions').insert({
    user_id: userId, plan_id: plan.id, plan_title: planTitle,
    price_stars: chargeStars, price_toman: priceToman, duration_days: plan.duration_days,
    provider: 'tonpays', tonpays_order_id: orderId,
    status: 'pending_payment', source: 'purchase',
  }).select('id').single()
  if (error || !tx) return { error: 'checkout_failed' }

  const create = () => createTelegramInvoice({ amountToman: priceToman, orderId, buyerChatId })

  let invoice: TonPaysInvoice
  try {
    invoice = await create()
  } catch (err) {
    if (!(err instanceof TonPaysApiError) || err.code !== 'BUYER_HAS_PENDING_INVOICE') {
      await db.from('premium_transactions').update({ status: 'canceled' }).eq('id', tx.id)
      return { error: 'checkout_failed' }
    }

    const { data: oldRow } = await db
      .from('premium_transactions')
      .select('id, plan_id, price_toman, tonpays_invoice_id, tonpays_final_amount')
      .eq('user_id', userId).eq('provider', 'tonpays').eq('status', 'pending_payment')
      .neq('id', tx.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (oldRow && oldRow.plan_id === plan.id && oldRow.price_toman === priceToman) {
      // Same purchase already has a live invoice at TonPays — this attempt never
      // got one, so drop it and resume the existing one instead.
      await db.from('premium_transactions').update({ status: 'canceled' }).eq('id', tx.id)
      await checkInvoice(oldRow.tonpays_invoice_id as string)
      return {
        transactionId: oldRow.id as string,
        provider: 'tonpays',
        payment: {
          cardNumber: '', cardHolder: '',
          amountToman: (oldRow.tonpays_final_amount as number | null) ?? (oldRow.price_toman as number),
          invoiceId: oldRow.tonpays_invoice_id as string,
        },
      }
    }

    if (oldRow) {
      await cancelInvoice(oldRow.tonpays_invoice_id as string)
      await db.from('premium_transactions').update({ status: 'canceled' }).eq('id', oldRow.id)
    }

    try {
      invoice = await create()
    } catch {
      await db.from('premium_transactions').update({ status: 'canceled' }).eq('id', tx.id)
      return { error: 'checkout_failed' }
    }
  }

  await db.from('premium_transactions').update({
    tonpays_invoice_id: invoice.invoiceId,
    tonpays_final_amount: invoice.finalAmount,
    tonpays_status: invoice.status,
  }).eq('id', tx.id)

  schedulePurchaseCheckoutFollowup(userId)

  return {
    transactionId: tx.id,
    provider: 'tonpays',
    payment: {
      cardNumber: invoice.cardNumber, cardHolder: invoice.cardHolder,
      amountToman: invoice.finalAmount, invoiceId: invoice.invoiceId,
    },
  }
}

export async function validatePremiumPreCheckout(transactionId: string, totalAmount: number, currency: string) {
  const { data: tx } = await db
    .from('premium_transactions').select('status, price_stars, user_id').eq('id', transactionId).maybeSingle()
  // Unknown tx → no buyer to look up, so the rejection falls back to Persian.
  if (!tx) return { ok: false as const, reason: tFor(null).premium.checkoutUnavailable }
  const { data: buyer } = await db.from('users').select('locale').eq('id', tx.user_id).maybeSingle()
  const t = tFor((buyer?.locale as Locale | null) ?? null)
  if (tx.status !== 'pending_payment') return { ok: false as const, reason: t.premium.checkoutAlreadyProcessed }
  if (currency !== 'XTR' || totalAmount !== tx.price_stars) return { ok: false as const, reason: t.premium.checkoutPriceMismatch }
  return { ok: true as const }
}

export async function handlePremiumPaid(transactionId: string, chargeId: string, buyerTelegramId: number, amountStars: number) {
  // Idempotency: only a still-pending row proceeds (guards Telegram update replays).
  const { data: tx } = await db
    .from('premium_transactions')
    .update({ status: 'paid', paid_at: new Date().toISOString(), telegram_payment_charge_id: chargeId })
    .eq('id', transactionId).eq('status', 'pending_payment')
    .select('id, user_id, duration_days').maybeSingle()
  if (!tx) return // already handled or unknown

  const { data: user } = await db.from('users').select('premium_until, name, locale').eq('id', tx.user_id).single()
  if (!user) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }

  const { error: updErr } = await db
    .from('users')
    .update({ premium_until: extendPremiumUntil(user.premium_until ?? null, tx.duration_days) })
    .eq('id', tx.user_id)
  if (updErr) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }

  // Confirmed grant — post an ops notice (best-effort; never blocks the payment).
  notifyPaymentChannel(formatPremiumPaidNotice({
    buyerName: user.name ?? null,
    durationDays: tx.duration_days,
    amountStars,
    chargeId,
    at: new Date().toISOString(),
  })).catch(() => {})

  notifyPremiumPurchased(buyerTelegramId, tx.duration_days, (user.locale as Locale | null) ?? null)
    .catch((err) => console.error('[premium] buyer DM failed:', err?.message ?? err))
}

/** Buyer paid but we couldn't grant time: refund the Stars and mark the tx.
 * If the refund API itself fails we log and leave the tx 'paid' so an admin
 * can refund manually via the recorded charge id. */
async function failAndRefund(txId: string, buyerTelegramId: number, chargeId: string) {
  try {
    await refundPremiumPayment(buyerTelegramId, chargeId)
    await db.from('premium_transactions').update({ status: 'refunded' }).eq('id', txId)
  } catch (e) {
    console.error('[premium] refund failed:', (e as Error)?.message)
  }
}

export async function getPremiumTransactionStatus(txId: string, userId: string) {
  const { data } = await db
    .from('premium_transactions').select('status, user_id').eq('id', txId).maybeSingle()
  if (!data || data.user_id !== userId) return null
  return { status: data.status }
}
