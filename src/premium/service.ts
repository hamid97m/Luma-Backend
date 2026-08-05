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

export async function validatePremiumPreCheckout(transactionId: string, totalAmount: number, currency: string) {
  const { data: tx } = await db
    .from('premium_transactions').select('status, price_stars').eq('id', transactionId).maybeSingle()
  if (!tx) return { ok: false as const, reason: 'This purchase is no longer available.' }
  if (tx.status !== 'pending_payment') return { ok: false as const, reason: 'This purchase was already processed.' }
  if (currency !== 'XTR' || totalAmount !== tx.price_stars) return { ok: false as const, reason: 'Price mismatch.' }
  return { ok: true as const }
}

export async function handlePremiumPaid(transactionId: string, chargeId: string, buyerTelegramId: number) {
  // Idempotency: only a still-pending row proceeds (guards Telegram update replays).
  const { data: tx } = await db
    .from('premium_transactions')
    .update({ status: 'paid', paid_at: new Date().toISOString(), telegram_payment_charge_id: chargeId })
    .eq('id', transactionId).eq('status', 'pending_payment')
    .select('id, user_id, duration_days').maybeSingle()
  if (!tx) return // already handled or unknown

  const { data: user } = await db.from('users').select('premium_until').eq('id', tx.user_id).single()
  if (!user) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }

  const { error: updErr } = await db
    .from('users')
    .update({ premium_until: extendPremiumUntil(user.premium_until ?? null, tx.duration_days) })
    .eq('id', tx.user_id)
  if (updErr) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }
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

/** True when the sender may NOT message this partner. Order matters: the gender
 * check is first so non-gated chats (and all existing tests) never touch the db. */
export async function premiumGateBlocks(senderId: string, partnerGender: string | null): Promise<boolean> {
  if (partnerGender !== 'woman') return false
  if (!(await isPremiumEnabled())) return false
  const { data: me, error } = await db.from('users').select('premium_until').eq('id', senderId).single()
  // Can't determine status (transient db error) — fail open rather than 403ing a possibly-paying user;
  // the gate re-checks on every send, so a genuine free user is only briefly ungated.
  if (error) return false
  return !isPremiumActive(me?.premium_until ?? null)
}
