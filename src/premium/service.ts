import { db } from '../db.js'
import { createPremiumInvoiceLink, refundPremiumPayment, notifyPaymentChannel, notifyPremiumPurchased } from '../bot.js'
import { formatPremiumPaidNotice, formatTonPaysPaidNotice, formatTonPaysGrantFailedNotice } from '../payments/paymentNotify.js'
import { schedulePurchaseCheckoutFollowup } from '../jobs/purchaseMessage.js'
import { tFor, type Locale } from '../i18n/index.js'
import {
  isTonPaysConfigured, createTelegramInvoice, checkInvoice, cancelInvoice,
  generateTonPaysOrderId, TonPaysApiError, changeCard, submitRefundCard,
  type TonPaysInvoice, type TonPaysCheck,
} from '../payments/tonpays.js'

export const PREMIUM_PAYLOAD_PREFIX = 'premium:'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TOMAN_PER_STAR = 3000
// How far back to look for one of our own rows that still carries a TonPays
// invoice id when TonPays reports a pending invoice we no longer track. Matches
// the sweep's ancient cutoff — nothing older than that can still be pending.
const TONPAYS_PENDING_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000

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
 *
 * The resume path acts on what the upstream check actually says: an invoice
 * that is already paid, or that has a transfer in flight against it
 * (`action_required_*`/a remaining amount), is NEVER cancelled — cancelling
 * one would orphan money the buyer has already sent. Only a plainly-pending
 * invoice with no card data to show (or a check that failed outright) falls
 * through to cancel-and-recreate.
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

  // The new attempt row never got an invoice, so dropping it is unconditional
  // (no paid-race to guard against) — unlike the old row's cancel below.
  const dropNewRow = () =>
    db.from('premium_transactions').update({ status: 'canceled' }).eq('id', tx.id)

  let invoice: TonPaysInvoice
  try {
    invoice = await create()
  } catch (err) {
    if (!(err instanceof TonPaysApiError) || err.code !== 'BUYER_HAS_PENDING_INVOICE') {
      await dropNewRow()
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
      // got one, so drop it and resume the existing one instead. A failed check
      // (network error, 429, TonPays 5xx) is treated the same as "no card
      // data": never let it propagate uncaught and leave this new row dangling.
      const oldInvoiceId = oldRow.tonpays_invoice_id as string
      let check: TonPaysCheck | null = null
      try {
        check = await checkInvoice(oldInvoiceId)
      } catch {
        check = null
      }

      const resumed = (cardNumber: string, cardHolder: string): PremiumCheckoutResult => ({
        transactionId: oldRow.id as string,
        provider: 'tonpays',
        payment: {
          cardNumber, cardHolder,
          amountToman: (oldRow.tonpays_final_amount as number | null) ?? (oldRow.price_toman as number),
          invoiceId: oldInvoiceId,
        },
      })

      // Already paid upstream: never cancel this invoice. Grant now (the claim
      // inside handleTonPaysPaid is idempotent) and hand the old transaction
      // back — the client's very first poll then sees `paid` and finishes.
      if (check?.paid) {
        const outcome = await handleTonPaysPaid(oldInvoiceId)
        console.warn(`[tonpays] resume: invoice ${oldInvoiceId} is already paid (outcome ${outcome}); resuming tx ${oldRow.id} instead of recreating`)
        await dropNewRow()
        return resumed(check.cardNumber ?? '', check.cardHolder ?? '')
      }

      // The check gave us a card to show — the plain resume case.
      if (check && check.cardNumber && check.cardHolder) {
        await dropNewRow()
        schedulePurchaseCheckoutFollowup(userId)
        return resumed(check.cardNumber, check.cardHolder)
      }

      // A transfer is already in flight against this invoice (underpaid /
      // overpaid), but the check carries no card to show. Cancelling it would
      // orphan money the buyer has already sent, so keep the invoice alive and
      // tell the client to come back to it rather than starting a new one.
      if (check && (check.status?.startsWith('action_required') || check.remainingAmount != null)) {
        console.warn(`[tonpays] resume: invoice ${oldInvoiceId} awaits buyer action (status ${check.status}); not cancelling, and no card data to resume with`)
        await dropNewRow()
        return { error: 'checkout_pending_action' }
      }

      // Plainly pending with no card data, or the check itself failed — fall
      // through to the same cancel-and-recreate path as a mismatched
      // plan/amount, below, so the buyer always ends up with a valid card +
      // amount instead of an empty one or an uncaught throw.
    }

    if (oldRow) {
      await cancelInvoice(oldRow.tonpays_invoice_id as string)
      // Guard on status='pending_payment': a webhook grant can land between
      // the SELECT above and this UPDATE, and clobbering `paid` back to
      // `canceled` would make handleTonPaysPaid's claim unmatchable forever —
      // money in, premium never granted. Same pattern as the sweep.
      await db.from('premium_transactions').update({ status: 'canceled' })
        .eq('id', oldRow.id).eq('status', 'pending_payment')
    } else {
      // No pending row of ours carries an invoice, yet TonPays insists this
      // buyer already has one (it allows exactly one per buyer). Without
      // recovery every future checkout for this user loops
      // BUYER_HAS_PENDING_INVOICE → checkout_failed, silently and forever.
      await recoverUntrackedPendingInvoice(userId, tx.id, err.message)
    }

    try {
      invoice = await create()
    } catch {
      await dropNewRow()
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

/**
 * Last-resort recovery when TonPays reports a pending invoice for a buyer that
 * no `pending_payment` row of ours accounts for — which happens when the sweep
 * cancelled our row locally, or a `create` response was lost after TonPays had
 * already made the invoice. Looks for the newest tonpays row of this buyer's
 * that still carries an invoice id *regardless of status* within the recovery
 * window and cancels that invoice upstream (best-effort) so the caller's one
 * retry of `create` can succeed. Always logs: either what it recovered, or
 * that the buyer is stuck until the invoice is cancelled in the TonPays panel.
 */
async function recoverUntrackedPendingInvoice(userId: string, newTxId: string, upstreamMessage: string): Promise<void> {
  const since = new Date(Date.now() - TONPAYS_PENDING_RECOVERY_WINDOW_MS).toISOString()
  const { data: stray } = await db
    .from('premium_transactions')
    .select('id, tonpays_invoice_id')
    .eq('user_id', userId).eq('provider', 'tonpays')
    .not('tonpays_invoice_id', 'is', null)
    .gte('created_at', since)
    .neq('id', newTxId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const strayInvoiceId = (stray?.tonpays_invoice_id as string | null | undefined) ?? null
  if (!strayInvoiceId) {
    console.error(
      `[tonpays] BUYER_HAS_PENDING_INVOICE for user ${userId} with no local invoice to reconcile — ` +
      `this buyer cannot check out until that invoice is cancelled in the TonPays panel. upstream: ${upstreamMessage}`,
    )
    return
  }

  console.warn(
    `[tonpays] recovering untracked pending invoice ${strayInvoiceId} (tx ${stray?.id}) for user ${userId} — ` +
    'cancelling it upstream before retrying create',
  )
  try {
    await cancelInvoice(strayInvoiceId)
  } catch (e) {
    console.error(`[tonpays] upstream cancel of untracked invoice ${strayInvoiceId} failed: ${(e as Error)?.message}`)
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

/**
 * TonPays twin of `handlePremiumPaid`, driven by the webhook's
 * `invoice.completed` event instead of a Telegram successful_payment update.
 * Looked up by `tonpays_invoice_id` (unique) rather than a transaction id —
 * the webhook only carries the invoice id.
 *
 * KEY DIFFERENCE from the Stars path: a card-to-card transfer can't be
 * auto-refunded. If the user row is missing or the premium_until update
 * fails, there is no `failAndRefund` — the transaction is left in
 * `paid_grant_failed` for manual admin follow-up and the failure is logged
 * loudly, since the buyer's money is otherwise in limbo.
 */
export async function handleTonPaysPaid(
  invoiceId: string,
): Promise<'granted' | 'already' | 'not_found' | 'grant_failed'> {
  // Idempotency: only a still-pending row proceeds (guards duplicate webhook deliveries).
  const { data: tx } = await db
    .from('premium_transactions')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('tonpays_invoice_id', invoiceId).eq('status', 'pending_payment')
    .select('id, user_id, duration_days, price_toman, tonpays_final_amount').maybeSingle()

  if (!tx) {
    // Either this invoice was already processed (a replay) or we've never
    // heard of it — distinguish the two so callers can treat them differently.
    const { data: existing } = await db
      .from('premium_transactions').select('id').eq('tonpays_invoice_id', invoiceId).maybeSingle()
    return existing ? 'already' : 'not_found'
  }

  const amountToman = (tx.tonpays_final_amount as number | null) ?? (tx.price_toman as number)

  const { data: user } = await db.from('users').select('premium_until, name, locale, telegram_id').eq('id', tx.user_id).single()
  if (!user) return markGrantFailed(tx.id, invoiceId, 'user row not found', { buyerName: null, amountToman })

  const { error: updErr } = await db
    .from('users')
    .update({ premium_until: extendPremiumUntil(user.premium_until ?? null, tx.duration_days) })
    .eq('id', tx.user_id)
  if (updErr) return markGrantFailed(tx.id, invoiceId, updErr.message, { buyerName: user.name ?? null, amountToman })

  // Confirmed grant — post an ops notice (best-effort; never blocks the payment).
  // Amount shown is the exact transfer TonPays confirmed (final_amount, which
  // includes their dedup offset), falling back to the nominal snapshot price.
  notifyPaymentChannel(formatTonPaysPaidNotice({
    buyerName: user.name ?? null,
    durationDays: tx.duration_days,
    amountToman,
    invoiceId,
    at: new Date().toISOString(),
  })).catch(() => {})

  notifyPremiumPurchased(user.telegram_id as number, tx.duration_days, (user.locale as Locale | null) ?? null)
    .catch((err) => console.error('[tonpays] buyer DM failed:', err?.message ?? err))

  return 'granted'
}

/** Buyer paid (confirmed by TonPays) but we couldn't grant the time — no
 * refund path exists for a bank transfer, so mark the row for manual admin
 * follow-up, log loudly, and alert the payment channel instead of silently
 * failing. The ops channel reports every successful purchase; money-arrived-
 * no-grant is the one case that actually needs a human, so it cannot be the
 * only payment event that goes unreported there. */
async function markGrantFailed(
  txId: string,
  invoiceId: string,
  reason: string,
  notice: { buyerName: string | null; amountToman: number },
): Promise<'grant_failed'> {
  console.error(`[tonpays] grant failed for invoice ${invoiceId} (tx ${txId}): ${reason}`)
  await db.from('premium_transactions').update({ status: 'paid_grant_failed' }).eq('id', txId)
  notifyPaymentChannel(formatTonPaysGrantFailedNotice({
    buyerName: notice.buyerName,
    amountToman: notice.amountToman,
    invoiceId,
    reason,
    at: new Date().toISOString(),
  })).catch(() => {})
  return 'grant_failed'
}

const TONPAYS_POLL_THROTTLE_MS = 5000

/** Cached result of the last real upstream check for a tx, keyed by tx id.
 * Serves two purposes: throttling (via `lastCheckMs`) and — so a throttled
 * call doesn't regress a just-reported `remainingAmount`/`refundPending`
 * back to null/false — answering throttled calls with the last real values
 * instead of defaults. Evicted once the tx reaches a terminal state, so this
 * never grows unbounded: a tx only ever occupies an entry while pending. */
type TonPaysPollCacheEntry = {
  lastCheckMs: number
  tonpaysStatus: string | null
  remainingAmount: number | null
  refundPending: boolean
}
const tonpaysPollCache = new Map<string, TonPaysPollCacheEntry>()

/** Test hook: clears the module-level poll cache between test cases. */
export function _resetTonPaysPollThrottle(): void {
  tonpaysPollCache.clear()
}

/** Test hook: whether a tx still has a cache entry (used to assert eviction on terminal states). */
export function _tonpaysPollCacheHas(txId: string): boolean {
  return tonpaysPollCache.has(txId)
}

const TONPAYS_TERMINAL_STATUSES = new Set(['paid', 'paid_grant_failed', 'canceled', 'refunded'])

export type PremiumTransactionStatus = {
  status: string
  provider: PaymentProvider
  tonpaysStatus?: string | null
  remainingAmount?: number | null
  refundPending?: boolean
}

/**
 * Status for a single transaction, with a poll-driven fallback for TonPays:
 * webhooks are the primary path, but if one is lost/delayed the client can
 * poll this endpoint and we'll check upstream ourselves. Only a still-pending
 * TonPays row triggers a check (anything already resolved just returns the
 * stored row), and checks are throttled per tx id so a tight client poll loop
 * doesn't hammer TonPays — a throttled call answers from the cached values of
 * the last real check, not stale defaults. A failed check never breaks the
 * poll — it falls back to the cached (or stored) state. Once a tx reaches a
 * terminal state the cache entry is evicted, so the throttle map never grows
 * unbounded.
 */
export async function getPremiumTransactionStatus(txId: string, userId: string): Promise<PremiumTransactionStatus | null> {
  const { data } = await db
    .from('premium_transactions')
    .select('status, user_id, provider, tonpays_invoice_id, tonpays_status')
    .eq('id', txId).maybeSingle()
  if (!data || data.user_id !== userId) return null

  const provider = ((data.provider as PaymentProvider | null) ?? 'stars')
  if (provider !== 'tonpays') return { status: data.status as string, provider }

  let status = data.status as string
  let tonpaysStatus = (data.tonpays_status as string | null) ?? null
  let remainingAmount: number | null = null
  let refundPending = false

  if (status === 'pending_payment' && data.tonpays_invoice_id) {
    const invoiceId = data.tonpays_invoice_id as string
    const now = Date.now()
    const cached = tonpaysPollCache.get(txId)

    if (cached && now - cached.lastCheckMs < TONPAYS_POLL_THROTTLE_MS) {
      // Throttled: answer from the last real check instead of upstream.
      tonpaysStatus = cached.tonpaysStatus
      remainingAmount = cached.remainingAmount
      refundPending = cached.refundPending
    } else {
      try {
        const check = await checkInvoice(invoiceId)
        tonpaysStatus = check.status
        remainingAmount = check.remainingAmount
        refundPending = check.refundPending
        tonpaysPollCache.set(txId, { lastCheckMs: now, tonpaysStatus, remainingAmount, refundPending })
        if (check.paid) {
          const result = await handleTonPaysPaid(invoiceId)
          status = result === 'grant_failed' ? 'paid_grant_failed' : 'paid'
        } else if (check.status === 'expired' || check.status === 'canceled') {
          // Guard on status='pending_payment': a webhook grant can land between
          // the row read above and this UPDATE, and clobbering `paid` back to
          // `canceled` would make handleTonPaysPaid's claim unmatchable forever.
          await db.from('premium_transactions')
            .update({ status: 'canceled', tonpays_status: check.status })
            .eq('id', txId).eq('status', 'pending_payment')
          status = 'canceled'
        }
      } catch {
        // Upstream check failed (network error, TonPays outage, etc) — fall
        // back to the cached (or stored) state rather than breaking the poll.
        // Still advance lastCheckMs: during an outage every poll would
        // otherwise skip the throttle and re-hit the failing upstream on
        // every single call, which is the worst time to hammer it.
        if (cached) {
          tonpaysStatus = cached.tonpaysStatus
          remainingAmount = cached.remainingAmount
          refundPending = cached.refundPending
        }
        tonpaysPollCache.set(txId, { lastCheckMs: now, tonpaysStatus, remainingAmount, refundPending })
      }
    }
  }

  if (TONPAYS_TERMINAL_STATUSES.has(status)) tonpaysPollCache.delete(txId)

  return { status, provider, tonpaysStatus, remainingAmount, refundPending }
}

export type ChangeTonPaysCardResult =
  | { ok: true; cardNumber: string; cardHolder: string }
  | { ok: false; code: 'not_found' | 'cooldown' | 'invalid_request' | 'upstream_error' }

/**
 * Requests a new receiving card from TonPays for a pending invoice.
 *
 * Error mapping (deliberately narrow, not "any 4xx"):
 *  - a TonPaysApiError whose `code` contains "COOLDOWN" (case-insensitive) or
 *    whose `httpStatus` is 429 → `cooldown` (TonPays' 60s change-card cooldown).
 *  - `INVALID_RESPONSE` (an unparseable body — proxy/gateway noise, not a
 *    real 4xx from TonPays' API) → `upstream_error`, regardless of the HTTP
 *    status it carried.
 *  - any other 4xx → `invalid_request` (e.g. an invoice that's no longer
 *    changeable) — distinct from `cooldown` so the client doesn't retry it
 *    the same way.
 *  - a 5xx, or anything that isn't a TonPaysApiError (network failure) → `upstream_error`.
 */
export async function changeTonPaysCard(txId: string, userId: string): Promise<ChangeTonPaysCardResult> {
  const row = await getOwnedTonPaysTx(txId, userId)
  if (!row) return { ok: false, code: 'not_found' }
  try {
    const card = await changeCard(row.tonpays_invoice_id as string)
    return { ok: true, cardNumber: card.cardNumber, cardHolder: card.cardHolder }
  } catch (err) {
    if (err instanceof TonPaysApiError) {
      if (err.httpStatus === 429 || err.code.toUpperCase().includes('COOLDOWN')) return { ok: false, code: 'cooldown' }
      if (err.code !== 'INVALID_RESPONSE' && err.httpStatus >= 400 && err.httpStatus < 500) {
        return { ok: false, code: 'invalid_request' }
      }
    }
    return { ok: false, code: 'upstream_error' }
  }
}

export type RefundCardResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'invalid_card' | 'upstream_error' }

/** Buyer-submitted card to receive a refund on, for a pending/refund-pending TonPays invoice. */
export async function submitTonPaysRefundCard(
  txId: string, userId: string, cardNumber: string, cardHolder: string,
): Promise<RefundCardResult> {
  const digits = cardNumber.replace(/\s+/g, '')
  if (!/^\d{16}$/.test(digits) || !cardHolder.trim()) return { ok: false, code: 'invalid_card' }

  const row = await getOwnedTonPaysTx(txId, userId)
  if (!row) return { ok: false, code: 'not_found' }

  try {
    await submitRefundCard(row.tonpays_invoice_id as string, digits, cardHolder.trim())
    return { ok: true }
  } catch {
    return { ok: false, code: 'upstream_error' }
  }
}

/** Shared ownership/kind guard for the change-card and refund-card endpoints:
 * both 404 unless the tx belongs to `userId` and is a tonpays row — never
 * leaking whether a foreign/stars tx id exists. */
async function getOwnedTonPaysTx(txId: string, userId: string) {
  const { data } = await db
    .from('premium_transactions').select('user_id, provider, tonpays_invoice_id').eq('id', txId).maybeSingle()
  if (!data || data.user_id !== userId || data.provider !== 'tonpays') return null
  return data
}
