import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
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
import { db } from '../src/db.js'
import { createPremiumInvoiceLink } from '../src/bot.js'
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
import { chainable } from './admin-helpers.js'
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
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    expect(resolvePaymentProvider('IR')).toBe('tonpays')
  })

  it('provider is stars for IR when key missing', () => {
    vi.stubEnv('TONPAYS_API_KEY', '')
    expect(resolvePaymentProvider('IR')).toBe('stars')
  })

  it('provider is stars for null and non-IR geo_country', () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    expect(resolvePaymentProvider(null)).toBe('stars')
    expect(resolvePaymentProvider('DE')).toBe('stars')
  })
})

describe('getTomanPerStar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads premium_config.toman_per_star', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { toman_per_star: 4200 } })
      return chainable({ data: null })
    })
    expect(await getTomanPerStar()).toBe(4200)
  })

  it('falls back to 3000 on a missing row', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null }))
    expect(await getTomanPerStar()).toBe(3000)
  })

  it('falls back to 3000 when the column is missing/null', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ data: { toman_per_star: null } }))
    expect(await getTomanPerStar()).toBe(3000)
  })
})

describe('getPremiumStatus', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  it('returns toggle, own expiry, and mapped plans — charged price while a discount is active, full price otherwise', async () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    const past = new Date(Date.now() - DAY_MS).toISOString()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null, geo_country: null } })
      if (table === 'premium_plans') return chainable({ data: [
        { id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100, discount_percent: null, discount_ends_at: null, duration_days: 30 },
        { id: 'p2', title: '3 Months', description: '', price_stars: 150, discount_percent: 50, discount_ends_at: null, duration_days: 90 },
        { id: 'p3', title: '6 Months', description: '', price_stars: 200, discount_percent: 25, discount_ends_at: future, duration_days: 180 },
        { id: 'p4', title: '12 Months', description: '', price_stars: 300, discount_percent: 40, discount_ends_at: past, duration_days: 365 },
      ] })
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.enabled).toBe(true)
    expect(res.premiumUntil).toBe(null)
    expect(res.paymentProvider).toBe('stars')
    expect(res.plans).toEqual([
      { id: 'p1', title: '1 Month', description: 'Best start', priceStars: 100, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 30 },
      { id: 'p2', title: '3 Months', description: '', priceStars: 75, discountPercent: 50, originalPriceStars: 150, discountEndsAt: null, durationDays: 90 },
      { id: 'p3', title: '6 Months', description: '', priceStars: 150, discountPercent: 25, originalPriceStars: 200, discountEndsAt: future, durationDays: 180 },
      { id: 'p4', title: '12 Months', description: '', priceStars: 300, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 365 },
    ])
  })

  it('provider is stars for IR when TonPays key is missing', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null, geo_country: 'IR' } })
      if (table === 'premium_plans') return chainable({ data: [] })
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.paymentProvider).toBe('stars')
  })

  it('carries paymentProvider "tonpays" and toman pricing (priceToman = chargedStars × rate) for an Iranian user when TonPays is configured', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true, toman_per_star: 3000 } })
      if (table === 'users') return chainable({ data: { premium_until: null, geo_country: 'IR' } })
      if (table === 'premium_plans') return chainable({ data: [
        { id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100, discount_percent: 20, discount_ends_at: null, duration_days: 30 },
      ] })
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.paymentProvider).toBe('tonpays')
    expect(res.plans[0]).toMatchObject({
      priceStars: 80, originalPriceStars: 100, priceToman: 240000, originalPriceToman: 300000,
    })
  })

  it('localizes plan copy from translations for the viewer\'s locale, falling back per field', async () => {
    const plansLog: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null, locale: 'en' } })
      if (table === 'premium_plans') return chainable({ data: [
        { id: 'p1', title: 'یک ماهه', description: 'شروع خوب', translations: { en: { title: '1 Month', description: 'Good start' } },
          price_stars: 100, discount_percent: null, discount_ends_at: null, duration_days: 30 },
        { id: 'p2', title: 'سه ماهه', description: 'بهترین', translations: { en: { title: '3 Months', description: '  ' } },
          price_stars: 150, discount_percent: null, discount_ends_at: null, duration_days: 90 },
        { id: 'p3', title: 'شش ماهه', description: '', translations: null,
          price_stars: 200, discount_percent: null, discount_ends_at: null, duration_days: 180 },
      ] }, plansLog)
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.plans.map((p) => [p.title, p.description])).toEqual([
      ['1 Month', 'Good start'],
      ['3 Months', 'بهترین'],   // blank translated description → Persian base
      ['شش ماهه', ''],          // no translations → Persian base
    ])
    // The query must actually fetch the jsonb column, or planText never sees a translation.
    const select = plansLog.find((e) => e.method === 'select')
    expect(String(select?.args[0])).toContain('translations')
  })

  it('keeps Persian copy for a viewer whose locale is still NULL', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null, locale: null } })
      if (table === 'premium_plans') return chainable({ data: [
        { id: 'p1', title: 'یک ماهه', description: 'شروع خوب', translations: { en: { title: '1 Month', description: 'Good start' } },
          price_stars: 100, discount_percent: null, discount_ends_at: null, duration_days: 30 },
      ] })
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.plans[0]).toMatchObject({ title: 'یک ماهه', description: 'شروع خوب' })
  })
})

describe('createPremiumCheckout', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockDb(opts: { enabled: boolean; plan: any; insertData?: any; buyer?: any }) {
    const inserts: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: opts.enabled } })
      if (table === 'premium_plans') return chainable({ data: opts.plan })
      if (table === 'users') return chainable({ data: opts.buyer ?? { locale: null } })
      if (table === 'premium_transactions') {
        return {
          insert: (payload: any) => { inserts.push(payload); return chainable({ data: opts.insertData ?? { id: 'tx1' }, error: null }) },
        } as any
      }
      return chainable({ data: null })
    })
    return inserts
  }

  it('rejects when premium is disabled', async () => {
    mockDb({ enabled: false, plan: null })
    expect(await createPremiumCheckout('u1', 'p1')).toEqual({ error: 'premium_disabled' })
  })

  it('rejects an unknown/inactive plan', async () => {
    mockDb({ enabled: true, plan: null })
    expect(await createPremiumCheckout('u1', 'p1')).toEqual({ error: 'plan_unavailable' })
  })

  it('inserts a pending snapshot tx at full price when no discount is configured', async () => {
    const inserts = mockDb({
      enabled: true,
      plan: {
        id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100,
        discount_percent: null, discount_ends_at: null, duration_days: 30,
      },
    })
    const res = await createPremiumCheckout('u1', 'p1')
    expect(res).toEqual({ transactionId: 'tx1', provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(inserts[0]).toMatchObject({
      user_id: 'u1', plan_id: 'p1', plan_title: '1 Month',
      price_stars: 100, duration_days: 30, status: 'pending_payment', source: 'purchase',
    })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', 'Best start', 100)
  })

  it('snapshots the discounted price when the discount is still active at checkout', async () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    const inserts = mockDb({
      enabled: true,
      plan: {
        id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100,
        discount_percent: 25, discount_ends_at: future, duration_days: 30,
      },
    })
    const res = await createPremiumCheckout('u1', 'p1')
    expect(res).toEqual({ transactionId: 'tx1', provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(inserts[0]).toMatchObject({ price_stars: 75 })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', 'Best start', 75)
  })

  it('snapshots the full price when the discount has already expired', async () => {
    const past = new Date(Date.now() - DAY_MS).toISOString()
    const inserts = mockDb({
      enabled: true,
      plan: {
        id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100,
        discount_percent: 25, discount_ends_at: past, duration_days: 30,
      },
    })
    const res = await createPremiumCheckout('u1', 'p1')
    expect(inserts[0]).toMatchObject({ price_stars: 100 })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', 'Best start', 100)
  })

  it('builds the invoice and snapshots plan_title in the buyer\'s language', async () => {
    const inserts = mockDb({
      enabled: true,
      buyer: { locale: 'en' },
      plan: {
        id: 'p1', title: 'یک ماهه', description: 'شروع خوب',
        translations: { en: { title: '1 Month', description: 'Good start' } },
        price_stars: 100, discount_percent: null, discount_ends_at: null, duration_days: 30,
      },
    })
    await createPremiumCheckout('u1', 'p1')
    expect(inserts[0]).toMatchObject({ plan_title: '1 Month' })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', 'Good start', 100)
  })

  it('uses the localized description fallback when the plan has no description', async () => {
    mockDb({
      enabled: true,
      buyer: { locale: 'en' },
      plan: {
        id: 'p1', title: 'یک ماهه', description: '', translations: { en: { title: '1 Month' } },
        price_stars: 100, discount_percent: null, discount_ends_at: null, duration_days: 30,
      },
    })
    await createPremiumCheckout('u1', 'p1')
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', en.premium.invoiceDescriptionFallback(30), 100)
  })
})

describe('createPremiumCheckout — tonpays', () => {
  const plan = {
    id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100,
    discount_percent: null, discount_ends_at: null, duration_days: 30,
  }

  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  // Routes all premium_transactions calls to the right fake: insert() for the
  // new attempt row, select() for the "find our existing pending row" lookup
  // (BUYER_HAS_PENDING_INVOICE path), update() for status/invoice writes.
  function mockTonPaysDb(opts: { plan: any; buyer?: any; tomanPerStar?: number; insertData?: any; oldRow?: any | null }) {
    const inserts: any[] = []
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true, toman_per_star: opts.tomanPerStar ?? 500 } })
      if (table === 'premium_plans') return chainable({ data: opts.plan })
      if (table === 'users') return chainable({ data: opts.buyer ?? { locale: null, geo_country: 'IR', telegram_id: 777 } })
      if (table === 'premium_transactions') {
        return {
          insert: (payload: any) => { inserts.push(payload); return chainable({ data: opts.insertData ?? { id: 'tx-new' }, error: null }) },
          select: () => chainable({ data: opts.oldRow ?? null }),
          update: (payload: any) => { updates.push(payload); return chainable({ data: null, error: null }) },
        } as any
      }
      return chainable({ data: null })
    })
    return { inserts, updates }
  }

  it('tonpays checkout inserts snapshot row and returns card payment', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-abc')
    vi.mocked(createTelegramInvoice).mockResolvedValue({
      invoiceId: 'inv-1', cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', finalAmount: 50037, status: 'pending',
    })
    const { inserts, updates } = mockTonPaysDb({ plan, tomanPerStar: 500 }) // 100 stars × 500 = 50000

    const res = await createPremiumCheckout('u1', 'p1')

    expect(res).toEqual({
      transactionId: 'tx-new', provider: 'tonpays',
      payment: { cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', amountToman: 50037, invoiceId: 'inv-1' },
    })
    expect(inserts[0]).toMatchObject({
      user_id: 'u1', plan_id: 'p1', provider: 'tonpays',
      price_stars: 100, price_toman: 50000, tonpays_order_id: 'order-abc',
      status: 'pending_payment', source: 'purchase',
    })
    expect(createTelegramInvoice).toHaveBeenCalledWith({ amountToman: 50000, orderId: 'order-abc', buyerChatId: 777 })
    expect(updates[0]).toMatchObject({ tonpays_invoice_id: 'inv-1', tonpays_final_amount: 50037, tonpays_status: 'pending' })
  })

  it('stars checkout unchanged for non-IR user', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123') // configured, but geo isn't IR
    const inserts: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'premium_plans') return chainable({ data: plan })
      if (table === 'users') return chainable({ data: { locale: null, geo_country: 'DE', telegram_id: 777 } })
      if (table === 'premium_transactions') {
        return { insert: (payload: any) => { inserts.push(payload); return chainable({ data: { id: 'tx1' }, error: null }) } } as any
      }
      return chainable({ data: null })
    })

    const res = await createPremiumCheckout('u1', 'p1')

    expect(res).toEqual({ transactionId: 'tx1', provider: 'stars', invoiceLink: 'https://t.me/invoice/prem' })
    expect(createTelegramInvoice).not.toHaveBeenCalled()
    expect(inserts[0]).toMatchObject({ price_stars: 100, status: 'pending_payment' })
  })

  it('resumes the pending invoice for same plan and amount, using the fresh card from checkInvoice', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    vi.mocked(createTelegramInvoice).mockRejectedValue(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'already pending', 409))
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'pending', paid: false, remainingAmount: null, refundPending: false,
      cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder',
    })

    const { updates } = mockTonPaysDb({
      plan, tomanPerStar: 500,
      oldRow: { id: 'tx-old', plan_id: 'p1', price_toman: 50000, tonpays_invoice_id: 'inv-old', tonpays_final_amount: 50037 },
    })

    const res = await createPremiumCheckout('u1', 'p1')

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).not.toHaveBeenCalled()
    expect(res).toEqual({
      transactionId: 'tx-old', provider: 'tonpays',
      payment: { cardNumber: '6037-xxxx-xxxx-1234', cardHolder: 'Card Holder', invoiceId: 'inv-old', amountToman: 50037 },
    })
    // the fresh never-invoiced attempt row is dropped, not left dangling as pending
    expect(updates.some((u) => u.status === 'canceled')).toBe(true)
    // resume is a successful checkout response too — the abandoned-checkout nudge still fires
    expect(schedulePurchaseCheckoutFollowup).toHaveBeenCalledWith('u1')
  })

  it('falls back to cancel-and-recreate when checkInvoice itself rejects', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'already pending', 409))
      .mockResolvedValueOnce({ invoiceId: 'inv-fresh', cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', finalAmount: 50037, status: 'pending' })
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    const { updates } = mockTonPaysDb({
      plan, tomanPerStar: 500,
      oldRow: { id: 'tx-old', plan_id: 'p1', price_toman: 50000, tonpays_invoice_id: 'inv-old', tonpays_final_amount: 50037 },
    })

    // Must not throw — the rejected checkInvoice must be handled, not propagated.
    const res = await createPremiumCheckout('u1', 'p1')

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect(updates.some((u) => u.status === 'canceled')).toBe(true)
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    expect(res).toEqual({
      transactionId: 'tx-new', provider: 'tonpays',
      payment: { cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', amountToman: 50037, invoiceId: 'inv-fresh' },
    })
  })

  it('falls back to cancel-and-recreate when the resume check has no card data', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'already pending', 409))
      .mockResolvedValueOnce({ invoiceId: 'inv-fresh', cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', finalAmount: 50037, status: 'pending' })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-old', status: 'pending', paid: false, remainingAmount: null, refundPending: false,
      cardNumber: null, cardHolder: null,
    })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    const { updates } = mockTonPaysDb({
      plan, tomanPerStar: 500,
      oldRow: { id: 'tx-old', plan_id: 'p1', price_toman: 50000, tonpays_invoice_id: 'inv-old', tonpays_final_amount: 50037 },
    })

    const res = await createPremiumCheckout('u1', 'p1')

    expect(checkInvoice).toHaveBeenCalledWith('inv-old')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect(updates.some((u) => u.status === 'canceled')).toBe(true)
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    expect(res).toEqual({
      transactionId: 'tx-new', provider: 'tonpays',
      payment: { cardNumber: '6037-zzzz-zzzz-0000', cardHolder: 'Fresh Card', amountToman: 50037, invoiceId: 'inv-fresh' },
    })
  })

  it('cancels and retries for a different plan', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    vi.mocked(createTelegramInvoice)
      .mockRejectedValueOnce(new TonPaysApiError('BUYER_HAS_PENDING_INVOICE', 'already pending', 409))
      .mockResolvedValueOnce({ invoiceId: 'inv-new', cardNumber: '6037-yyyy-yyyy-9999', cardHolder: 'New Card', finalAmount: 60012, status: 'pending' })
    vi.mocked(cancelInvoice).mockResolvedValue(undefined)

    const { updates } = mockTonPaysDb({
      plan, tomanPerStar: 500,
      oldRow: { id: 'tx-old', plan_id: 'p2', price_toman: 999, tonpays_invoice_id: 'inv-old', tonpays_final_amount: 1000 },
    })

    const res = await createPremiumCheckout('u1', 'p1')

    expect(cancelInvoice).toHaveBeenCalledWith('inv-old')
    expect(updates.some((u) => u.status === 'canceled')).toBe(true)
    expect(createTelegramInvoice).toHaveBeenCalledTimes(2)
    expect(res).toEqual({
      transactionId: 'tx-new', provider: 'tonpays',
      payment: { cardNumber: '6037-yyyy-yyyy-9999', cardHolder: 'New Card', amountToman: 60012, invoiceId: 'inv-new' },
    })
  })

  it('marks the row canceled when create fails outright', async () => {
    vi.stubEnv('TONPAYS_API_KEY', 'key123')
    vi.mocked(generateTonPaysOrderId).mockReturnValue('order-new')
    vi.mocked(createTelegramInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const { updates } = mockTonPaysDb({ plan, tomanPerStar: 500 })

    const res = await createPremiumCheckout('u1', 'p1')

    expect(res).toEqual({ error: 'checkout_failed' })
    expect(updates[0]).toMatchObject({ status: 'canceled' })
  })
})

describe('getPremiumTransactionStatus — tonpays poll fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetTonPaysPollThrottle() })

  // premium_transactions.select() answers the poll's own row fetch; its
  // update() answers either handleTonPaysPaid's claim-and-grant update or the
  // markGrantFailed/markCanceled update, depending on the scenario under test
  // (each test only exercises one of those paths).
  function mockPremiumTxDb(opts: { txRow: any; txUpdateResult?: any; usersRow?: any }) {
    const txUpdates: any[] = []
    const userUpdates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') {
        return {
          select: () => chainable({ data: opts.txRow }),
          update: (payload: any) => { txUpdates.push(payload); return chainable({ data: opts.txUpdateResult ?? null }) },
        } as any
      }
      if (table === 'users') {
        return {
          select: () => chainable({ data: opts.usersRow }),
          update: (payload: any) => { userUpdates.push(payload); return chainable({ data: null, error: null }) },
        } as any
      }
      return chainable({ data: null })
    })
    return { txUpdates, userUpdates }
  }

  it('returns stored state unchanged for a non-pending or stars row, without calling checkInvoice', async () => {
    mockPremiumTxDb({ txRow: { status: 'paid', user_id: 'u1', provider: 'stars', tonpays_invoice_id: null, tonpays_status: null } })
    const res = await getPremiumTransactionStatus('tx1', 'u1')
    expect(res).toEqual({ status: 'paid', provider: 'stars' })
    expect(checkInvoice).not.toHaveBeenCalled()
  })

  it('poll on pending tonpays tx checks upstream and grants when paid', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
      txUpdateResult: { id: 'tx1', user_id: 'u1', duration_days: 30, price_toman: 50000, tonpays_final_amount: 50037 },
      usersRow: { premium_until: null, name: 'Ali', locale: null, telegram_id: 777 },
    })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'paid', paid: true, remainingAmount: 0, refundPending: false, cardNumber: null, cardHolder: null,
    })

    const res = await getPremiumTransactionStatus('tx1', 'u1')

    expect(checkInvoice).toHaveBeenCalledWith('inv1')
    // the grant actually ran (not just reported) — premium_until was extended on the user row
    expect(res).toEqual({ status: 'paid', provider: 'tonpays', tonpaysStatus: 'paid', remainingAmount: 0, refundPending: false })
    // terminal state — the throttle/cache entry must not linger forever
    expect(_tonpaysPollCacheHas('tx1')).toBe(false)
  })

  it('poll throttles upstream checks within 5s', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'pending', paid: false, remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await getPremiumTransactionStatus('tx1', 'u1')
    const second = await getPremiumTransactionStatus('tx1', 'u1')

    expect(checkInvoice).toHaveBeenCalledTimes(1)
    // throttled call still answers from the row's stored state, not an error
    expect(second).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('a throttled call reports the last real remainingAmount/refundPending instead of resetting to null/false', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'refund_pending', paid: false, remainingAmount: 12000, refundPending: true, cardNumber: null, cardHolder: null,
    })

    const first = await getPremiumTransactionStatus('tx1', 'u1')
    const second = await getPremiumTransactionStatus('tx1', 'u1')

    expect(checkInvoice).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'refund_pending', remainingAmount: 12000, refundPending: true })
    // must not flicker back to null/false during the throttle window
    expect(second).toEqual(first)
  })

  it('poll marks the row canceled on expired status', async () => {
    const { txUpdates } = mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'expired', paid: false, remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    const res = await getPremiumTransactionStatus('tx1', 'u1')

    expect(res).toEqual({ status: 'canceled', provider: 'tonpays', tonpaysStatus: 'expired', remainingAmount: null, refundPending: false })
    expect(txUpdates).toContainEqual({ status: 'canceled', tonpays_status: 'expired' })
    // terminal state — the throttle/cache entry must not linger forever
    expect(_tonpaysPollCacheHas('tx1')).toBe(false)
  })

  it('evicts the throttle/cache entry once a tx reaches a terminal state, but keeps it while still pending', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockResolvedValueOnce({
      invoiceId: 'inv1', status: 'pending', paid: false, remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })
    await getPremiumTransactionStatus('tx1', 'u1')
    expect(_tonpaysPollCacheHas('tx1')).toBe(true) // still pending — cache kept for the throttle window

    _resetTonPaysPollThrottle() // bypass the 5s throttle so the next call actually re-checks upstream
    vi.mocked(checkInvoice).mockResolvedValueOnce({
      invoiceId: 'inv1', status: 'paid', paid: true, remainingAmount: 0, refundPending: false, cardNumber: null, cardHolder: null,
    })
    await getPremiumTransactionStatus('tx1', 'u1')
    expect(_tonpaysPollCacheHas('tx1')).toBe(false) // now terminal — evicted
  })

  it('a checkInvoice failure does not break the poll — returns the stored state', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const res = await getPremiumTransactionStatus('tx1', 'u1')

    expect(res).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('a failed check still advances the throttle, so an outage does not get hammered on every poll', async () => {
    mockPremiumTxDb({
      txRow: { status: 'pending_payment', user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' },
    })
    vi.mocked(checkInvoice).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    const first = await getPremiumTransactionStatus('tx1', 'u1')
    const second = await getPremiumTransactionStatus('tx1', 'u1')

    expect(checkInvoice).toHaveBeenCalledTimes(1) // the second poll must be throttled, not re-hit the failing upstream
    expect(second).toEqual(first)
    expect(second).toEqual({ status: 'pending_payment', provider: 'tonpays', tonpaysStatus: 'pending', remainingAmount: null, refundPending: false })
  })

  it('returns null for another user or an unknown tx', async () => {
    mockPremiumTxDb({ txRow: { status: 'pending_payment', user_id: 'other', provider: 'tonpays', tonpays_invoice_id: 'inv1', tonpays_status: 'pending' } })
    expect(await getPremiumTransactionStatus('tx1', 'u1')).toBeNull()
    mockPremiumTxDb({ txRow: null })
    expect(await getPremiumTransactionStatus('tx9', 'u1')).toBeNull()
  })
})

describe('changeTonPaysCard', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockTxLookup(row: any) {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') return chainable({ data: row })
      return chainable({ data: null })
    })
  }

  it('returns the new card on success', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    vi.mocked(changeCard).mockResolvedValue({ cardNumber: '6037-1111', cardHolder: 'New Holder' })

    const res = await changeTonPaysCard('tx1', 'u1')

    expect(changeCard).toHaveBeenCalledWith('inv1')
    expect(res).toEqual({ ok: true, cardNumber: '6037-1111', cardHolder: 'New Holder' })
  })

  it('maps a TonPays error with a COOLDOWN code, or httpStatus 429, to the cooldown code', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })

    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('COOLDOWN', 'wait 60s', 400))
    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'cooldown' })

    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('change_card_cooldown', 'wait', 400))
    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'cooldown' }) // case-insensitive match

    vi.mocked(changeCard).mockRejectedValueOnce(new TonPaysApiError('SOME_OTHER_CODE', 'rate limited', 429))
    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'cooldown' }) // httpStatus 429 alone is enough
  })

  it('maps a non-cooldown 4xx to invalid_request, not cooldown', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INVALID_INVOICE', 'invoice not changeable', 400))

    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'invalid_request' })
  })

  it('maps an unexpected 5xx to an upstream error, not cooldown', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'upstream_error' })
  })

  it('maps INVALID_RESPONSE to an upstream error even when its carried httpStatus looks like a 4xx', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    vi.mocked(changeCard).mockRejectedValue(new TonPaysApiError('INVALID_RESPONSE', 'tonpays_invalid_json_http_400', 400))

    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'upstream_error' })
  })

  it('reports not_found for a foreign tx or a stars row', async () => {
    mockTxLookup({ user_id: 'other', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'not_found' })

    mockTxLookup({ user_id: 'u1', provider: 'stars', tonpays_invoice_id: null })
    expect(await changeTonPaysCard('tx1', 'u1')).toEqual({ ok: false, code: 'not_found' })
  })
})

describe('submitTonPaysRefundCard', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockTxLookup(row: any) {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_transactions') return chainable({ data: row })
      return chainable({ data: null })
    })
  }

  it('validates card number (16 digits after stripping spaces) and non-empty holder, and forwards to tonpays', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })

    expect(await submitTonPaysRefundCard('tx1', 'u1', '1234', 'Ali')).toEqual({ ok: false, code: 'invalid_card' })
    expect(await submitTonPaysRefundCard('tx1', 'u1', '6037 9911 2233 4455', '')).toEqual({ ok: false, code: 'invalid_card' })
    expect(await submitTonPaysRefundCard('tx1', 'u1', '6037 9911 2233 4455', '   ')).toEqual({ ok: false, code: 'invalid_card' })
    expect(submitRefundCard).not.toHaveBeenCalled()

    vi.mocked(submitRefundCard).mockResolvedValue(undefined)
    const res = await submitTonPaysRefundCard('tx1', 'u1', '6037 9911 2233 4455', 'Ali Rezaei')
    expect(res).toEqual({ ok: true })
    expect(submitRefundCard).toHaveBeenCalledWith('inv1', '6037991122334455', 'Ali Rezaei')
  })

  it('reports not_found for a foreign tx or a stars row', async () => {
    mockTxLookup({ user_id: 'other', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    expect(await submitTonPaysRefundCard('tx1', 'u1', '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'not_found' })

    mockTxLookup({ user_id: 'u1', provider: 'stars', tonpays_invoice_id: null })
    expect(await submitTonPaysRefundCard('tx1', 'u1', '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'not_found' })
  })

  it('reports an upstream_error when tonpays rejects the refund submission', async () => {
    mockTxLookup({ user_id: 'u1', provider: 'tonpays', tonpays_invoice_id: 'inv1' })
    vi.mocked(submitRefundCard).mockRejectedValue(new TonPaysApiError('INTERNAL_ERROR', 'boom', 500))

    expect(await submitTonPaysRefundCard('tx1', 'u1', '6037991122334455', 'Ali')).toEqual({ ok: false, code: 'upstream_error' })
  })
})
