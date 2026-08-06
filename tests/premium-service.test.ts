import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn().mockResolvedValue('https://t.me/invoice/prem'),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { createPremiumInvoiceLink } from '../src/bot.js'
import {
  isPremiumActive, extendPremiumUntil, discountActive, chargedPrice,
  getPremiumStatus, createPremiumCheckout,
} from '../src/premium/service.js'
import { chainable } from './admin-helpers.js'

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

describe('getPremiumStatus', () => {
  beforeEach(() => vi.clearAllMocks())
  it('returns toggle, own expiry, and mapped plans — charged price while a discount is active, full price otherwise', async () => {
    const future = new Date(Date.now() + DAY_MS).toISOString()
    const past = new Date(Date.now() - DAY_MS).toISOString()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null } })
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
    expect(res.plans).toEqual([
      { id: 'p1', title: '1 Month', description: 'Best start', priceStars: 100, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 30 },
      { id: 'p2', title: '3 Months', description: '', priceStars: 75, discountPercent: 50, originalPriceStars: 150, discountEndsAt: null, durationDays: 90 },
      { id: 'p3', title: '6 Months', description: '', priceStars: 150, discountPercent: 25, originalPriceStars: 200, discountEndsAt: future, durationDays: 180 },
      { id: 'p4', title: '12 Months', description: '', priceStars: 300, discountPercent: null, originalPriceStars: null, discountEndsAt: null, durationDays: 365 },
    ])
  })
})

describe('createPremiumCheckout', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockDb(opts: { enabled: boolean; plan: any; insertData?: any }) {
    const inserts: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: opts.enabled } })
      if (table === 'premium_plans') return chainable({ data: opts.plan })
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
    expect(res).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/prem' })
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
    expect(res).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/prem' })
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
})
