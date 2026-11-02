import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn().mockResolvedValue('https://t.me/invoice/prem'),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/payments/tonpays.js', async () => {
  const actual = await vi.importActual<typeof import('../src/payments/tonpays.js')>('../src/payments/tonpays.js')
  return {
    ...actual,
    createTelegramInvoice: vi.fn(),
    checkInvoice: vi.fn(),
    cancelInvoice: vi.fn(),
    generateTonPaysOrderId: vi.fn(),
    changeCard: vi.fn(),
    submitRefundCard: vi.fn(),
  }
})
vi.mock('../src/jobs/purchaseMessage.js', () => ({ schedulePurchaseCheckoutFollowup: vi.fn() }))
import { createPremiumInvoiceLink, notifyPaymentChannel } from '../src/bot.js'
import {
  isPremiumActive, extendPremiumUntil, discountActive, chargedPrice,
  getPremiumStatus, createPremiumCheckout, resolvePaymentProvider, getTomanPerStar,
  getPremiumTransactionStatus, changeTonPaysCard, submitTonPaysRefundCard,
  _resetTonPaysPollThrottle, _tonpaysPollCacheHas,
} from '../src/premium/service.js'
import {
  createTelegramInvoice, checkInvoice, cancelInvoice, generateTonPaysOrderId, TonPaysApiError,
  changeCard, submitRefundCard,
} from '../src/payments/tonpays.js'
import { schedulePurchaseCheckoutFollowup } from '../src/jobs/purchaseMessage.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { setPremiumConfig, createPlan, createTx, getTx, failPremiumUntilUpdates, restoreUserUpdates } from './helpers/premium.js'
import { en } from '../src/i18n/en.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('isPremiumActive', () => {
  it('false for null', () => expect(isPremiumActive(null)).toBe(false))
  it('false for a past date', () => expect(isPremiumActive(new Date(Date.now() - 1000).toISOString())).toBe(false))
  it('true for a future date', () => expect(isPremiumActive(new Date(Date.now() + 1000).toISOString())).toBe(true))
})

describe('extendPremiumUntil', () => {
  const now = 1_800_000_000_000
  it('starts from now when no current expiry', () => {
    expect(extendPremiumUntil(null, 30, now)).toBe(new Date(now + 30 * DAY_MS).toISOString())
  })
  it('starts from now when current expiry is in the past', () => {
    expect(extendPremiumUntil(new Date(now - DAY_MS).toISOString(), 7, now))
      .toBe(new Date(now + 7 * DAY_MS).toISOString())
  })
  it('stacks on top of a future expiry', () => {
    const current = new Date(now + 5 * DAY_MS).toISOString()
    expect(extendPremiumUntil(current, 30, now)).toBe(new Date(now + 35 * DAY_MS).toISOString())
  })
})

describe('discountActive', () => {
  it('false when no discount percent is set', () => expect(discountActive(null, null)).toBe(false))
  it('false when discount percent is 0', () => expect(discountActive(0, null)).toBe(false))
  it('true when percent is set and there is no deadline', () => expect(discountActive(50, null)).toBe(true))
  it('true when the deadline is in the future', () => {
    expect(discountActive(50, new Date(Date.now() + 1000).toISOString())).toBe(true)
  })
  it('false when the deadline is in the past', () => {
    expect(discountActive(50, new Date(Date.now() - 1000).toISOString())).toBe(false)
  })
})

describe('chargedPrice', () => {
  it('applies the percent discount, rounding to the nearest star', () => expect(chargedPrice(100, 25)).toBe(75))
  it('rounds to the nearest integer', () => expect(chargedPrice(99, 33)).toBe(66))
  it('floors at 1 star even for a near-100% discount', () => expect(chargedPrice(1, 99)).toBe(1))
  it('floors at 1 star when rounding would hit 0', () => expect(chargedPrice(10, 95)).toBe(1))
})

describe('resolvePaymentProvider', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('provider is tonpays for IR when key configured', () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123'); vi.stubEnv('TONPAYS_CHECKOUT_ENABLED', 'true')
    expect(resolvePaymentProvider('IR')).toBe('tonpays')
  })

  it('provider is stars for IR when TonPays checkout is not enabled (default)', () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    expect(resolvePaymentProvider('IR')).toBe('stars')
  })

  it('provider is stars for IR when key missing', () => {
    vi.stubEnv('TONPAYS_API_KEY', '')
    expect(resolvePaymentProvider('IR')).toBe('stars')
  })

  it('provider is stars for null and non-IR geo_country', () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123'); vi.stubEnv('TONPAYS_CHECKOUT_ENABLED', 'true')
    expect(resolvePaymentProvider(null)).toBe('stars')
    expect(resolvePaymentProvider('DE')).toBe('stars')
  })
})


const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'

describe('getTomanPerStar', () => {
  beforeEach(async () => { vi.clearAllMocks(); await resetDb() })

  it('reads premium_config.toman_per_star', async () => {
    await setPremiumConfig({ toman_per_star: 4200 })
    expect(await getTomanPerStar()).toBe(4200)
  })

  it('falls back to 3000 on a missing row', async () => {
    await sql`delete from premium_config`
    expect(await getTomanPerStar()).toBe(3000)
  })

  it('uses the column default (3000) on a fresh install', async () => {
    // The column is NOT NULL DEFAULT 3000, so "null column" can no longer happen;
    // the fresh singleton row carries the default instead.
    expect(await getTomanPerStar()).toBe(3000)
  })
})

describe('getPremiumStatus', () => {
  beforeEach(async () => { vi.clearAllMocks(); await resetDb() })
  afterEach(() => vi.unstubAllEnvs())

  it('returns toggle, own expiry, and mapped plans — charged price while a discount is active, full price otherwise', async () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    const past = new Date(Date.now() - DAY_MS).toISOString()
    await setPremiumConfig({ premium_enabled: true })
    const me = await createUser({ geo_country: null })
    // inserted out of order: sort_order decides; inactive plans are hidden
    const p3 = await createPlan({ title: '6 Months', description: '', price_stars: 200, discount_percent: 25, discount_ends_at: future, duration_days: 180, sort_order: 3 })
    const p1 = await createPlan({ title: '1 Month', description: 'Best start', price_stars: 100, duration_days: 30, sort_order: 1 })
    const p4 = await createPlan({ title: '12 Months', description: '', price_stars: 300, discount_percent: 40, discount_ends_at: past, duration_days: 365, sort_order: 4 })
    const p2 = await createPlan({ title: '3 Months', description: '', price_stars: 150, discount_percent: 50, duration_days: 90, sort_order: 2 })
    await createPlan({ title: 'Hidden', is_active: false, sort_order: 0 })

    const res = await getPremiumStatus(me.id)
    expect(res.enabled).toBe(true)
    expect(res.premiumUntil).toBe(null)
    expect(res.paymentProvider).toBe('stars')
    expect(res.plans).toEqual([
      { id: p1.id, title: '1 Month', description: 'Best start', priceStars: 100, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 30 },
      { id: p2.id, title: '3 Months', description: '', priceStars: 75, discountPercent: 50, originalPriceStars: 150, discountEndsAt: null, durationDays: 90 },
      { id: p3.id, title: '6 Months', description: '', priceStars: 150, discountPercent: 25, originalPriceStars: 200, discountEndsAt: future, durationDays: 180 },
      { id: p4.id, title: '12 Months', description: '', priceStars: 300, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 365 },
    ])
  })

  it('reports the toggle off and the viewer\'s own premium_until', async () => {
    const until = new Date(Date.now() + 3 * DAY_MS).toISOString()
    const me = await createUser({ premium_until: until })
    const res = await getPremiumStatus(me.id)
    expect(res.enabled).toBe(false)
    expect(res.premiumUntil).toBe(until)
    expect(res.plans).toEqual([])
  })

  it('provider is stars for IR when TonPays key is missing', async () => {
    await setPremiumConfig({ premium_enabled: true })
    const me = await createUser({ geo_country: 'IR' })
    const res = await getPremiumStatus(me.id)
    expect(res.paymentProvider).toBe('stars')
  })

  it('carries paymentProvider "tonpays" and toman pricing (priceToman = chargedStars × rate) for an Iranian user when TonPays is configured', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123'); vi.stubEnv('TONPAYS_CHECKOUT_ENABLED', 'true')
    await setPremiumConfig({ premium_enabled: true, toman_per_star: 3000 })
    const me = await createUser({ geo_country: 'IR' })
    await createPlan({ price_stars: 100, discount_percent: 20 })
    const res = await getPremiumStatus(me.id)
    expect(res.paymentProvider).toBe('tonpays')
    expect(res.plans[0]).toMatchObject({
      priceStars: 80, originalPriceStars: 100, priceToman: 240000, originalPriceToman: 300000,
    })
  })

  it('localizes plan copy from translations for the viewer\'s locale, falling back per field', async () => {
    await setPremiumConfig({ premium_enabled: true })
    const me = await createUser({ locale: 'en' })
    await createPlan({ title: 'یک ماهه', description: 'شروع خوب', translations: sql.json({ en: { title: '1 Month', description: 'Good start' } }), sort_order: 1 })
    await createPlan({ title: 'سه ماهه', description: 'بهترین', translations: sql.json({ en: { title: '3 Months', description: '  ' } }), sort_order: 2 })
    await createPlan({ title: 'شش ماهه', description: '', sort_order: 3 }) // translations column default {}
    const res = await getPremiumStatus(me.id)
    expect(res.plans.map((p) => [p.title, p.description])).toEqual([
      ['1 Month', 'Good start'],
      ['3 Months', 'بهترین'],   // blank translated description → Persian base
      ['شش ماهه', ''],          // no translations → Persian base
    ])
  })

  it('keeps Persian copy for a viewer whose locale is still NULL', async () => {
    await setPremiumConfig({ premium_enabled: true })
    const me = await createUser({ locale: null })
    await createPlan({ title: 'یک ماهه', description: 'شروع خوب', translations: sql.json({ en: { title: '1 Month', description: 'Good start' } }) })
    const res = await getPremiumStatus(me.id)
    expect(res.plans[0]).toMatchObject({ title: 'یک ماهه', description: 'شروع خوب' })
  })
})

describe('createPremiumCheckout', () => {
  beforeEach(async () => { vi.clearAllMocks(); await resetDb() })

  const txsOf = (userId: string) =>
    sql`select * from premium_transactions where user_id = ${userId} order by created_at`

  async function setup(opts: { enabled: boolean; plan?: Record<string, unknown>; buyer?: Record<string, unknown> }) {
    await setPremiumConfig({ premium_enabled: opts.enabled })
    const buyer = await createUser({ locale: null, ...opts.buyer })
    const plan = await createPlan({ title: '1 Month', description: 'Best start', price_stars: 100, duration_days: 30, ...opts.plan })
    return { buyer, plan }
  }

  it('rejects when premium is disabled', async () => {
    const { buyer, plan } = await setup({ enabled: false })
    expect(await createPremiumCheckout(buyer.id, plan.id)).toEqual({ error: 'premium_disabled' })
    expect(await txsOf(buyer.id)).toEqual([])
  })

  it('rejects an unknown/inactive plan', async () => {
    const { buyer } = await setup({ enabled: true })
    const inactive = await createPlan({ is_active: false })
    expect(await createPremiumCheckout(buyer.id, UNKNOWN_ID)).toEqual({ error: 'plan_unavailable' })
    expect(await createPremiumCheckout(buyer.id, inactive.id)).toEqual({ error: 'plan_unavailable' })
  })

  it('rejects a malformed plan id as unavailable (no 22P02 throw)', async () => {
    const { buyer } = await setup({ enabled: true })
    expect(await createPremiumCheckout(buyer.id, 'p1')).toEqual({ error: 'plan_unavailable' })
  })

  it('inserts a pending snapshot tx at full price when no discount is configured', async () => {
    const { buyer, plan } = await setup({ enabled: true })
    const res = await createPremiumCheckout(buyer.id, plan.id)
    const [tx] = await txsOf(buyer.id)
    expect(res).toEqual({ transactionId: tx.id, provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(tx).toMatchObject({
      user_id: buyer.id, plan_id: plan.id, plan_title: '1 Month', provider: 'stars',
      price_stars: 100, duration_days: 30, status: 'pending_payment', source: 'purchase',
    })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith(tx.id, '1 Month', 'Best start', 100)
    expect(schedulePurchaseCheckoutFollowup).toHaveBeenCalledWith(buyer.id)
  })

  it('snapshots the discounted price when the discount is still active at checkout', async () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    const { buyer, plan } = await setup({ enabled: true, plan: { discount_percent: 25, discount_ends_at: future } })
    const res = await createPremiumCheckout(buyer.id, plan.id)
    const [tx] = await txsOf(buyer.id)
    expect(res).toEqual({ transactionId: tx.id, provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(tx).toMatchObject({ price_stars: 75 })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith(tx.id, '1 Month', 'Best start', 75)
  })

  it('snapshots the full price when the discount has already expired', async () => {
    const past = new Date(Date.now() - DAY_MS).toISOString()
    const { buyer, plan } = await setup({ enabled: true, plan: { discount_percent: 25, discount_ends_at: past } })
    await createPremiumCheckout(buyer.id, plan.id)
    const [tx] = await txsOf(buyer.id)
    expect(tx).toMatchObject({ price_stars: 100 })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith(tx.id, '1 Month', 'Best start', 100)
  })

  it('builds the invoice and snapshots plan_title in the buyer\'s language', async () => {
    const { buyer, plan } = await setup({
      enabled: true, buyer: { locale: 'en' },
      plan: { title: 'یک ماهه', description: 'شروع خوب', translations: sql.json({ en: { title: '1 Month', description: 'Good start' } }) },
    })
    await createPremiumCheckout(buyer.id, plan.id)
    const [tx] = await txsOf(buyer.id)
    expect(tx).toMatchObject({ plan_title: '1 Month' })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith(tx.id, '1 Month', 'Good start', 100)
  })

  it('uses the localized description fallback when the plan has no description', async () => {
    const { buyer, plan } = await setup({
      enabled: true, buyer: { locale: 'en' },
      plan: { title: 'یک ماهه', description: '', translations: sql.json({ en: { title: '1 Month' } }) },
    })
    await createPremiumCheckout(buyer.id, plan.id)
    const [tx] = await txsOf(buyer.id)
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith(tx.id, '1 Month', en.premium.invoiceDescriptionFallback(30), 100)
  })
})

describe('createPremiumCheckout — tonpays', () => {
  let buyer: Record<string, any>
  let plan: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    vi.stubEnv('TONPAYS_API_KEY', 'key123'); vi.stubEnv('TONPAYS_CHECKOUT_ENABLED', 'true')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    await setPremiumConfig({ premium_enabled: true, toman_per_star: 500 }) // 100 stars × 500 = 50000
    buyer = await createUser({ locale: null, geo_country: 'IR', telegram_id: 777, name: 'Ali' })
    plan = await createPlan({ title: '1 Month', description: 'Best start', price_stars: 100, duration_days: 30 })
  })
  afterEach(() => vi.unstubAllEnvs())

  /** The row this checkout attempt inserted (order id 'order-new'). */
  const newRow = async () => (await sql`select * from premium_transactions where tonpays_order_id = 'order-new'`)[0]

  /** An existing pending TonPays tx of the buyer's, already invoiced upstream. */
  const existingPending = (overrides: Record<string, unknown> = {}) => createTx(buyer.id, {
    provider: 'tonpays', plan_id: plan.id, price_toman: 50000, tonpays_invoice_id: 'inv-old',
    tonpays_final_amount: 50037, tonpays_order_id: 'order-old',
    created_at: new Date(Date.now() - 60_000).toISOString(), ...overrides,
  })

  const pendingConflict = () => new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'already pending', 409)

  it('tonpays checkout inserts snapshot row and returns card payment', async () => {
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-abc')
    vi.mocked(createTelegramInvoice).mockResolvedValue({
      invoiceId: 'inv-1', cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', finalAmount: 50037, status: 'pending',
    })

    const res = await createPremiumCheckout(buyer.id, plan.id)

    const [tx] = await sql`select * from premium_transactions`
    expect(res).toEqual({
      transactionId: tx.id, provider: 'tonpays',
      payment: { cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', amountToman: 50037, invoiceId: 'inv-1' },
    })
    expect(tx).toMatchObject({
      user_id: buyer.id, plan_id: plan.id, provider: 'tonpays',
      price_stars: 100, price_toman: 50000, tonpays_order_id: 'order-abc',
      status: 'pending_payment', source: 'purchase',
      // the invoice details are written back onto the row
      tonpays_invoice_id: 'inv-1', tonpays_final_amount: 50037, tonpays_status: 'pending',
    })
    expect(createTelegramInvoice).toHaveBeenCalledWith({ amountToman: 50000, orderId: 'order-abc', buyerChatId: 777 })
    expect(schedulePurchaseCheckoutFollowup).toHaveBeenCalledWith(buyer.id)
  })

  it('stars checkout unchanged for non-IR user', async () => {
    await sql`update users set geo_country = 'DE' where id = ${buyer.id}` // configured, but geo isn't IR

    const res = await createPremiumCheckout(buyer.id, plan.id)

    const [tx] = await sql`select * from premium_transactions`
    expect(res).toEqual({ transactionId: tx.id, provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(createTelegramInvoice).not.toHaveBeenCalled()
    expect(tx).toMatchObject({ provider: 'stars', price_stars: 100, price_toman: null, status: 'pending_payment' })
  })

  it('resumes the pending invoice for same plan and amount, using the fresh card from checkInvoice', async () => {
    const old = await existingPending()
    vi.mocked(createTelegramInvoice).mockRejectedValue(pendingConflict())
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'pending', paid: false, remainingAmount: null, refundPending: false,
      cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder',
    })

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).not.toHaveBeenCalled()
    expect(res).toEqual({
      transactionId: old.id, provider: 'tonpays',
      payment: { cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', invoiceId: 'inv-old', amountToman: 50037 },
    })
    // the fresh never-invoiced attempt row is dropped, not left dangling as pending
    expect((await newRow()).status).toBe('canceled')
    expect((await getTx(old.id)).status).toBe('pending_payment')
    // resume is a successful checkout response too — the abandoned-checkout nudge still fires
    expect(schedulePurchaseCheckoutFollowup).toHaveBeenCalledWith(buyer.id)
  })

  it('resume falls back to price_toman when the old row has no final amount', async () => {
    const old = await existingPending({ tonpays_final_amount: null })
    vi.mocked(createTelegramInvoice).mockRejectedValue(pendingConflict())
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'pending', paid: false, remainingAmount: null, refundPending: false,
      cardNumber: '6037', cardHolder: 'Holder',
    })
    const res = await createPremiumCheckout(buyer.id, plan.id)
    expect(res).toMatchObject({ transactionId: old.id, payment: { amountToman: 50000 } })
  })

  it('falls back to cancel-and-recreate when checkInvoice itself rejects', async () => {
    const old = await existingPending()
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(pendingConflict())
      .mockResolvedValueOnce({ invoiceId: 'inv-fresh', cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', finalAmount: 50037, status: 'pending' })
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    // Must not throw — the rejected checkInvoice must be handled, not propagated.
    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect((await getTx(old.id)).status).toBe('canceled')
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    const fresh = await newRow()
    expect(fresh).toMatchObject({ status: 'pending_payment', tonpays_invoice_id: 'inv-fresh' })
    expect(res).toEqual({
      transactionId: fresh.id, provider: 'tonpays',
      payment: { cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', amountToman: 50037, invoiceId: 'inv-fresh' },
    })
  })

  it('falls back to cancel-and-recreate when the resume check has no card data', async () => {
    const old = await existingPending()
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(pendingConflict())
      .mockResolvedValueOnce({ invoiceId: 'inv-fresh', cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', finalAmount: 50037, status: 'pending' })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'pending', paid: false, remainingAmount: null, refundPending: false,
      cardNumber: null, cardHolder: null,
    })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect((await getTx(old.id)).status).toBe('canceled')
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    const fresh = await newRow()
    expect(res).toEqual({
      transactionId: fresh.id, provider: 'tonpays',
      payment: { cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', amountToman: 50037, invoiceId: 'inv-fresh' },
    })
  })

  it('cancels and retries for a different plan', async () => {
    const otherPlan = await createPlan({ title: '3 Months', price_stars: 2 })
    const old = await existingPending({ plan_id: otherPlan.id, price_toman: 999, tonpays_final_amount: 1000 })
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(pendingConflict())
      .mockResolvedValueOnce({ invoiceId: 'inv-new', cardNumber: '6037-yyyy-yyyy-9999', cardHolder: 'New Card', finalAmount: 60012, status: 'pending' })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).not.toHaveBeenCalled()
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect((await getTx(old.id)).status).toBe('canceled')
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    const fresh = await newRow()
    expect(res).toEqual({
      transactionId: fresh.id, provider: 'tonpays',
      payment: { cardNumber: '6037-yyyy-yyyy-9999', cardHolder: 'New Card', amountToman: 60012, invoiceId: 'inv-new' },
    })
  })

  it('cancels and retries for the same plan at a different amount', async () => {
    const old = await existingPending({ price_toman: 40000 })
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(pendingConflict())
      .mockResolvedValueOnce({ invoiceId: 'inv-new', cardNumber: 'c', cardHolder: 'h', finalAmount: 50001, status: 'pending' })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).not.toHaveBeenCalled()
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect((await getTx(old.id)).status).toBe('canceled')
  })

  it('the old row\'s cancel is guarded on status=pending_payment: a grant landing mid-checkout is never clobbered', async () => {
    const otherPlan = await createPlan({ title: '3 Months', price_stars: 2 })
    const old = await existingPending({ plan_id: otherPlan.id, price_toman: 999 })
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(pendingConflict())
      .mockResolvedValueOnce({ invoiceId: 'inv-new', cardNumber: 'c', cardHolder: 'h', finalAmount: 50001, status: 'pending' })
    // The webhook grant for the old invoice lands between our lookup and our cancel.
    vi.mocked(cancelInvoice).mockImplementation(async () => {
      await sql`update premium_transactions set status = 'paid' where id = ${old.id}`
    })

    await createPremiumCheckout(buyer.id, plan.id)

    expect((await getTx(old.id)).status).toBe('paid')
  })

  it('resume: an already-paid invoice is granted and never cancelled', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const old = await existingPending()
    vi.mocked(createTelegramInvoice).mockRejectedValue(pendingConflict())
    // A paid invoice's check carries no card fields (confirmed live).
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'paid', paid: true, remainingAmount: 0, refundPending: false,
      cardNumber: null, cardHolder: null,
    })

    const res = await createPremiumCheckout(buyer.id, plan.id)

    // The buyer's money is already on this invoice — cancelling it is the one
    // thing we must never do here.
    expect(cancelInvoice).not.toHaveBeenCalled()
    expect(createTelegramInvoice).toHaveBeenCalledTimes(1) // no recreate
    // The grant ran (not just reported): row paid, time added, ops notice posted.
    expect((await getTx(old.id)).status).toBe('paid')
    const [u] = await sql`select premium_until from users where id = ${buyer.id}`
    expect(new Date(u.premium_until).getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS)
    expect(vi.mocked(notifyPaymentChannel).mock.calls.flat().join('\n')).toContain('💎 Premium purchased (TonPays)')
    // The old transaction is handed back, so the client's first poll sees paid.
    expect(res).toEqual({
      transactionId: old.id, provider: 'tonpays',
      payment: { cardNumber: '', cardHolder: '', amountToman: 50037, invoiceId: 'inv-old' },
    })
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('already paid')
    expect((await newRow()).status).toBe('canceled') // the never-invoiced attempt row is dropped
    warnSpy.mockRestore()
  })

  it('resume: an invoice awaiting buyer action is not cancelled — reports checkout_pending_action', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const old = await existingPending()
    vi.mocked(createTelegramInvoice).mockRejectedValue(pendingConflict())
    // Underpaid: a transfer already landed on this invoice, but the check
    // gives us no card to show.
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'action_required_less', paid: false, remainingAmount: 12000, refundPending: false,
      cardNumber: null, cardHolder: null,
    })

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(cancelInvoice).not.toHaveBeenCalled() // would orphan money already transferred
    expect(createTelegramInvoice).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ error: 'checkout_pending_action' })
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('awaits buyer action')
    expect((await newRow()).status).toBe('canceled')
    expect((await getTx(old.id)).status).toBe('pending_payment')
    warnSpy.mockRestore()
  })

  it('recovers from an untracked upstream pending invoice: cancels it and retries create once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'invoice inv-stray is pending', 409))
      .mockResolvedValueOnce({ invoiceId: 'inv-fresh', cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', finalAmount: 50037, status: 'pending' })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    // No pending row of ours (the sweep already cancelled it locally), but a
    // recent canceled row still carries the live upstream invoice id. An older
    // one (outside the 48h window) must not be picked.
    await existingPending({ status: 'canceled', tonpays_invoice_id: 'inv-ancient', tonpays_order_id: 'o1', created_at: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString() })
    await existingPending({ status: 'canceled', tonpays_invoice_id: 'inv-stray', tonpays_order_id: 'o2' })

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(checkInvoice).not.toHaveBeenCalled()
    expect(vi.mocked(cancelInvoice).mock.calls).toEqual([['inv-stray']])
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    const fresh = await newRow()
    expect(res).toEqual({
      transactionId: fresh.id, provider: 'tonpays',
      payment: { cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', amountToman: 50037, invoiceId: 'inv-fresh' },
    })
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('inv-stray')
    warnSpy.mockRestore()
  })

  it('still retries once and logs loudly when no local invoice can be reconciled', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createTelegramInvoice).mockRejectedValue(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'buyer has a pending invoice', 409))

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(cancelInvoice).not.toHaveBeenCalled()
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ error: 'checkout_failed' })
    expect((await newRow()).status).toBe('canceled')
    // The silent-forever-loop case from the review: it must at least be loud.
    const logged = errSpy.mock.calls.flat().join(' ')
    expect(logged).toContain('BUYER_HAS_PENDING_INVOICE')
    expect(logged).toContain('buyer has a pending invoice') // the upstream message rides along
    errSpy.mockRestore()
  })

  it('marks the row canceled when create fails outright', async () => {
    vi.mocked(createTelegramInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const res = await createPremiumCheckout(buyer.id, plan.id)

    expect(res).toEqual({ error: 'checkout_failed' })
    expect(await newRow()).toMatchObject({ status: 'canceled', tonpays_invoice_id: null })
  })
})

describe('getPremiumTransactionStatus — tonpays poll fallback', () => {
  let me: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    _resetTonPaysPollThrottle()
    await resetDb()
    me = await createUser({ name: 'Ali', locale: null, telegram_id: 777 })
  })
  afterEach(async () => { await restoreUserUpdates() })

  const pendingTonPays = (overrides: Record<string, unknown> = {}) => createTx(me.id, {
    provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending',
    price_toman: 50000, tonpays_final_amount: 50037, ...overrides,
  })

  const pendingCheck = { invoiceId: 'inv1', status: 'pending', paid: false, remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null }
  const paidCheck = { invoiceId: 'inv1', status: 'paid', paid: true, remainingAmount: 0, refundPending: false, cardNumber: null, cardHolder: null }

  it('returns stored state unchanged for a non-pending or stars row, without calling checkInvoice', async () => {
    const stars = await createTx(me.id, { status: 'paid' })
    expect(await getPremiumTransactionStatus(stars.id, me.id)).toEqual({ status: 'paid', provider: 'stars' })
    const done = await pendingTonPays({ status: 'canceled' })
    expect(await getPremiumTransactionStatus(done.id, me.id)).toEqual({
      status: 'canceled', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false,
    })
    expect(checkInvoice).not.toHaveBeenCalled()
  })

  it('poll on pending tonpays tx checks upstream and grants when paid', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockResolvedValue(paidCheck)

    const res = await getPremiumTransactionStatus(tx.id, me.id)

    expect(checkInvoice).toHaveBeenCalledWith('inv1')
    expect(res).toEqual({ status: 'paid', provider: 'tonpays', tonpaysStatus: 'paid', remainingAmount: 0, refundPending: false })
    // the grant actually ran (not just reported) — premium_until was extended on the user row
    expect((await getTx(tx.id)).status).toBe('paid')
    const [u] = await sql`select premium_until from users where id = ${me.id}`
    expect(new Date(u.premium_until).getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS)
    // terminal state — the throttle/cache entry must not linger forever
    expect(_tonpaysPollCacheHas(tx.id)).toBe(false)
  })

  it('poll throttles upstream checks within 5s', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockResolvedValue(pendingCheck)

    await getPremiumTransactionStatus(tx.id, me.id)
    const second = await getPremiumTransactionStatus(tx.id, me.id)

    expect(checkInvoice).toHaveBeenCalledTimes(1)
    // throttled call still answers from the row's stored state, not an error
    expect(second).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('a throttled call reports the last real remainingAmount/refundPending instead of resetting to null/false', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockResolvedValue({ ...pendingCheck, status: 'refund_pending', remainingAmount: 12000, refundPending: true })

    const first = await getPremiumTransactionStatus(tx.id, me.id)
    const second = await getPremiumTransactionStatus(tx.id, me.id)

    expect(checkInvoice).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'refund_pending', remainingAmount: 12000, refundPending: true })
    // must not flicker back to null/false during the throttle window
    expect(second).toEqual(first)
  })

  it('poll marks the row canceled on expired status', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockResolvedValue({ ...pendingCheck, status: 'expired' })

    const res = await getPremiumTransactionStatus(tx.id, me.id)

    expect(res).toEqual({ status: 'canceled', provider: 'tonpays', tonpaysStatus: 'expired', remainingAmount: null, refundPending: false })
    expect(await getTx(tx.id)).toMatchObject({ status: 'canceled', tonpays_status: 'expired' })
    // terminal state — the throttle/cache entry must not linger forever
    expect(_tonpaysPollCacheHas(tx.id)).toBe(false)
  })

  it('the expired cancel is guarded on status=pending_payment: a webhook grant landing mid-poll is never clobbered', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockImplementation(async () => {
      await sql`update premium_transactions set status = 'paid' where id = ${tx.id}`
      return { ...pendingCheck, status: 'expired' }
    })

    await getPremiumTransactionStatus(tx.id, me.id)

    // (the response itself still says canceled — unchanged legacy behaviour)
    expect(await getTx(tx.id)).toMatchObject({ status: 'paid', tonpays_status: 'pending' })
  })

  it('a failed grant marks paid_grant_failed and alerts the payment channel', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tx = await pendingTonPays()
    await failPremiumUntilUpdates('db exploded')
    vi.mocked(checkInvoice).mockResolvedValue(paidCheck)

    const res = await getPremiumTransactionStatus(tx.id, me.id)

    expect(res).toMatchObject({ status: 'paid_grant_failed' })
    expect((await getTx(tx.id)).status).toBe('paid_grant_failed')
    // Money arrived and nothing was granted — ops must hear about it on the
    // same channel that reports successes, not only in a log line.
    const alert = vi.mocked(notifyPaymentChannel).mock.calls.flat().join('\n')
    expect(alert).toContain('🚨 TonPays payment received but grant FAILED')
    expect(alert).toContain('Buyer: Ali')
    expect(alert).toContain('Amount: 50037 Toman')
    expect(alert).toContain('Invoice: inv1')
    expect(alert).toContain('Reason: db exploded')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('evicts the throttle/cache entry once a tx reaches a terminal state, but keeps it while still pending', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockResolvedValueOnce(pendingCheck)
    await getPremiumTransactionStatus(tx.id, me.id)
    expect(_tonpaysPollCacheHas(tx.id)).toBe(true) // still pending — cache kept for the throttle window

    _resetTonPaysPollThrottle() // bypass the 5s throttle so the next call actually re-checks upstream
    vi.mocked(checkInvoice).mockResolvedValueOnce(paidCheck)
    await getPremiumTransactionStatus(tx.id, me.id)
    expect(_tonpaysPollCacheHas(tx.id)).toBe(false) // now terminal — evicted
  })

  it('a checkInvoice failure does not break the poll — returns the stored state', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const res = await getPremiumTransactionStatus(tx.id, me.id)

    expect(res).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('a failed check still advances the throttle, so an outage does not get hammered on every poll', async () => {
    const tx = await pendingTonPays()
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const first = await getPremiumTransactionStatus(tx.id, me.id)
    const second = await getPremiumTransactionStatus(tx.id, me.id)

    expect(checkInvoice).toHaveBeenCalledTimes(1) // the second poll must be throttled, not re-hit the failing upstream
    expect(second).toEqual(first)
    expect(second).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('a pending row with no invoice id yet is answered from storage without an upstream check', async () => {
    const tx = await pendingTonPays({ tonpays_invoice_id: null, tonpays_status: null })
    expect(await getPremiumTransactionStatus(tx.id, me.id)).toEqual({
      status: 'pending_payment', provider: 'tonpays', tonpaysStatus: null, remainingAmount: null, refundPending: false,
    })
    expect(checkInvoice).not.toHaveBeenCalled()
  })

  it('returns null for another user, an unknown tx, or a malformed id', async () => {
    const other = await createUser()
    const foreign = await createTx(other.id, { provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    expect(await getPremiumTransactionStatus(foreign.id, me.id)).toBeNull()
    expect(await getPremiumTransactionStatus(UNKNOWN_ID, me.id)).toBeNull()
    expect(await getPremiumTransactionStatus('tx9', me.id)).toBeNull()
    expect(checkInvoice).not.toHaveBeenCalled()
  })
})

describe('changeTonPaysCard', () => {
  let me: Record<string, any>
  let tx: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    me = await createUser()
    tx = await createTx(me.id, { provider: 'tonpays', tonpays_invoice_id: 'inv1' })
  })

  it('returns the new card on success', async () => {
    vi.mocked(changeCard).mockResolvedValue({ cardNumber: '6037-1111', cardHolder: 'New Holder' })

    const res = await changeTonPaysCard(tx.id, me.id)

    expect(changeCard).toHaveBeenCalledWith('inv1')
    expect(res).toEqual({ ok: true, cardNumber: '6037-1111', cardHolder: 'New Holder' })
  })

  it('maps a TonPays error with a COOLDOWN code, or httpStatus 429, to the cooldown code', async () => {
    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('COOLDOWN', 'wait 60s', 400))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'cooldown' })

    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('change_card_cooldown', 'wait', 400))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'cooldown' }) // case-insensitive match

    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('SOME_OTHER_CODE', 'rate limited', 429))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'cooldown' }) // httpStatus 429 alone is enough
  })

  it('maps a non-cooldown 4xx to invalid_request, not cooldown', async () => {
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INVALID_INVOICE', 'invoice not changeable', 400))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'invalid_request' })
  })

  it('maps an unexpected 5xx to an upstream error, not cooldown', async () => {
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'upstream_error' })
  })

  it('maps INVALID_RESPONSE to an upstream error even when its carried httpStatus looks like a 4xx', async () => {
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INVALID_RESPONSE', 'tonpays_invalid_json_http_400', 400))
    expect(await changeTonPaysCard(tx.id, me.id)).toEqual({ ok: false, code: 'upstream_error' })
  })

  it('reports not_found for a foreign tx, a stars row, an unknown or a malformed id', async () => {
    const other = await createUser()
    const foreign = await createTx(other.id, { provider: 'tonpays', tonpays_invoice_id: 'inv2' })
    expect(await changeTonPaysCard(foreign.id, me.id)).toEqual({ ok: false, code: 'not_found' })

    const stars = await createTx(me.id)
    expect(await changeTonPaysCard(stars.id, me.id)).toEqual({ ok: false, code: 'not_found' })

    expect(await changeTonPaysCard(UNKNOWN_ID, me.id)).toEqual({ ok: false, code: 'not_found' })
    expect(await changeTonPaysCard('tx9', me.id)).toEqual({ ok: false, code: 'not_found' })
    expect(changeCard).not.toHaveBeenCalled()
  })
})

describe('submitTonPaysRefundCard', () => {
  let me: Record<string, any>
  let tx: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    me = await createUser()
    tx = await createTx(me.id, { provider: 'tonpays', tonpays_invoice_id: 'inv1' })
  })

  it('validates card number (16 digits after stripping spaces) and non-empty holder, and forwards to tonpays', async () => {
    expect(await submitTonPaysRefundCard(tx.id, me.id, '1234', 'Ali')).toEqual({ ok: false, code: 'invalid_card' })
    expect(await submitTonPaysRefundCard(tx.id, me.id, '6037 9911 2233 4455', '')).toEqual({ ok: false, code: 'invalid_card' })
    expect(await submitTonPaysRefundCard(tx.id, me.id, '6037 9911 2233 4455', '   ')).toEqual({ ok: false, code: 'invalid_card' })
    expect(submitRefundCard).not.toHaveBeenCalled()

    vi.mocked(submitRefundCard).mockResolvedValue(undefined)
    const res = await submitTonPaysRefundCard(tx.id, me.id, '6037 9911 2233 4455', 'Ali Rezaei')
    expect(res).toEqual({ ok: true })
    expect(submitRefundCard).toHaveBeenCalledWith('inv1', '6037991122334455', 'Ali Rezaei')
  })

  it('reports not_found for a foreign tx, a stars row or a malformed id', async () => {
    const other = await createUser()
    const foreign = await createTx(other.id, { provider: 'tonpays', tonpays_invoice_id: 'inv2' })
    expect(await submitTonPaysRefundCard(foreign.id, me.id, '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'not_found' })

    const stars = await createTx(me.id)
    expect(await submitTonPaysRefundCard(stars.id, me.id, '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'not_found' })

    expect(await submitTonPaysRefundCard('tx9', me.id, '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'not_found' })
  })

  it('reports an upstream_error when tonpays rejects the refund submission', async () => {
    vi.mocked(submitRefundCard).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))
    expect(await submitTonPaysRefundCard(tx.id, me.id, '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'upstream_error' })
  })
})
