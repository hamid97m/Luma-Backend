import { db } from '../db.js'
import { createPremiumInvoiceLink, refundPremiumPayment } from '../bot.js'

export const PREMIUM_PAYLOAD_PREFIX = 'premium:'
const DAY_MS = 24 * 60 * 60 * 1000

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

/** Display-only strikethrough price backed out of the real price and discount %. */
export function computeOriginalPrice(priceStars: number, discountPercent: number | null): number | null {
  if (!discountPercent) return null
  return Math.round(priceStars / (1 - discountPercent / 100))
}

export async function isPremiumEnabled(): Promise<boolean> {
  const { data } = await db.from('premium_config').select('premium_enabled').eq('id', true).single()
  return data?.premium_enabled === true
}

export async function getPremiumStatus(userId: string) {
  const [{ data: cfg }, { data: me }, { data: plans }] = await Promise.all([
    db.from('premium_config').select('premium_enabled').eq('id', true).single(),
    db.from('users').select('premium_until').eq('id', userId).single(),
    db.from('premium_plans')
      .select('id, title, description, price_stars, discount_percent, duration_days')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
  ])
  return {
    enabled: cfg?.premium_enabled === true,
    premiumUntil: me?.premium_until ?? null,
    plans: (plans ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      priceStars: p.price_stars,
      discountPercent: p.discount_percent ?? null,
      originalPriceStars: computeOriginalPrice(p.price_stars, p.discount_percent ?? null),
      durationDays: p.duration_days,
    })),
  }
}

export async function createPremiumCheckout(userId: string, planId: string) {
  if (!(await isPremiumEnabled())) return { error: 'premium_disabled' }

  const { data: plan } = await db
    .from('premium_plans')
    .select('id, title, description, price_stars, duration_days')
    .eq('id', planId).eq('is_active', true)
    .maybeSingle()
  if (!plan) return { error: 'plan_unavailable' }

  const { data: tx, error } = await db.from('premium_transactions').insert({
    user_id: userId, plan_id: plan.id, plan_title: plan.title,
    price_stars: plan.price_stars, duration_days: plan.duration_days,
    status: 'pending_payment', source: 'purchase',
  }).select('id').single()
  if (error || !tx) return { error: 'checkout_failed' }

  const invoiceLink = await createPremiumInvoiceLink(
    tx.id, plan.title, plan.description || `Premium for ${plan.duration_days} days`, plan.price_stars,
  )
  return { transactionId: tx.id, invoiceLink }
}
