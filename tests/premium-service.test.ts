import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn().mockResolvedValue('https://t.me/invoice/prem'),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { createPremiumInvoiceLink } from '../src/bot.js'
import {
  isPremiumActive, extendPremiumUntil, computeOriginalPrice,
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

describe('computeOriginalPrice', () => {
  it('null without a discount', () => expect(computeOriginalPrice(100, null)).toBe(null))
  it('back-computes the original price', () => expect(computeOriginalPrice(50, 50)).toBe(100))
  it('rounds to an integer', () => expect(computeOriginalPrice(70, 30)).toBe(100))
})

describe('getPremiumStatus', () => {
  beforeEach(() => vi.clearAllMocks())
  it('returns toggle, own expiry, and mapped active plans', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'premium_config') return chainable({ data: { premium_enabled: true } })
      if (table === 'users') return chainable({ data: { premium_until: null } })
      if (table === 'premium_plans') return chainable({ data: [
        { id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100, discount_percent: null, duration_days: 30 },
        { id: 'p2', title: '3 Months', description: '', price_stars: 150, discount_percent: 50, duration_days: 90 },
      ] })
      return chainable({ data: null })
    })
    const res = await getPremiumStatus('u1')
    expect(res.enabled).toBe(true)
    expect(res.premiumUntil).toBe(null)
    expect(res.plans).toEqual([
      { id: 'p1', title: '1 Month', description: 'Best start', priceStars: 100, discountPercent: null, originalPriceStars: null, durationDays: 30 },
      { id: 'p2', title: '3 Months', description: '', priceStars: 150, discountPercent: 50, originalPriceStars: 300, durationDays: 90 },
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

  it('inserts a pending snapshot tx and returns the invoice link', async () => {
    const inserts = mockDb({
      enabled: true,
      plan: { id: 'p1', title: '1 Month', description: 'Best start', price_stars: 100, duration_days: 30 },
    })
    const res = await createPremiumCheckout('u1', 'p1')
    expect(res).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/prem' })
    expect(inserts[0]).toMatchObject({
      user_id: 'u1', plan_id: 'p1', plan_title: '1 Month',
      price_stars: 100, duration_days: 30, status: 'pending_payment', source: 'purchase',
    })
    expect(createPremiumInvoiceLink).toHaveBeenCalledWith('tx1', '1 Month', 'Best start', 100)
  })
})
