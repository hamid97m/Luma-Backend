import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { refundPremiumPayment, notifyPaymentChannel, notifyPremiumPurchased } from '../src/bot.js'
import { validatePremiumPreCheckout, handlePremiumPaid } from '../src/premium/service.js'
import { en } from '../src/i18n/en.js'
import { fa } from '../src/i18n/fa.js'

/** Claim step: update -> eq -> eq -> select -> maybeSingle, returning `data`. */
function claimStep(data: any) {
  return { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data }) }) }) }) }) }
}
/** Lookup step: select -> eq -> single/maybeSingle, returning `data`. */
function lookupStep(data: any) {
  const leaf = { single: () => ({ data }), maybeSingle: () => ({ data }) }
  return { select: () => ({ eq: () => leaf }) }
}
/** update() spy step: captures the payload, then eq() resolves with `error`. */
function updateSpyStep(spy: (payload: any) => void, error: any = null) {
  return { update: (payload: any) => { spy(payload); return { eq: () => ({ error }) } } }
}
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

const PAID_TX = { id: 'tx1', user_id: 'u1', duration_days: 30 }
const PENDING_TX = { status: 'pending_payment', price_stars: 100, user_id: 'u1' }

describe('validatePremiumPreCheckout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a pending tx with matching amount', async () => {
    scriptDb([lookupStep(PENDING_TX), lookupStep({ locale: 'fa' })])
    expect(await validatePremiumPreCheckout('tx1', 100, 'XTR')).toEqual({ ok: true })
  })
  it('rejects an unknown tx in Persian (no buyer to look up)', async () => {
    scriptDb([lookupStep(null)])
    expect(await validatePremiumPreCheckout('tx1', 100, 'XTR'))
      .toEqual({ ok: false, reason: fa.premium.checkoutUnavailable })
    expect(db.from).toHaveBeenCalledTimes(1)
  })
  it('rejects an already-processed tx in the buyer\'s language', async () => {
    scriptDb([lookupStep({ ...PENDING_TX, status: 'paid' }), lookupStep({ locale: 'en' })])
    expect(await validatePremiumPreCheckout('tx1', 100, 'XTR'))
      .toEqual({ ok: false, reason: en.premium.checkoutAlreadyProcessed })
  })
  it('rejects an amount mismatch in the buyer\'s language', async () => {
    scriptDb([lookupStep(PENDING_TX), lookupStep({ locale: 'en' })])
    expect(await validatePremiumPreCheckout('tx1', 50, 'XTR'))
      .toEqual({ ok: false, reason: en.premium.checkoutPriceMismatch })
  })
  it('falls back to Persian when the buyer has no locale yet', async () => {
    scriptDb([lookupStep(PENDING_TX), lookupStep({ locale: null })])
    expect(await validatePremiumPreCheckout('tx1', 50, 'XTR'))
      .toEqual({ ok: false, reason: fa.premium.checkoutPriceMismatch })
  })
})

describe('handlePremiumPaid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims the tx and extends premium_until', async () => {
    const userUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),                       // 1. pending -> paid claim
      lookupStep({ premium_until: null, locale: 'en' }), // 2. current expiry + locale lookup
      updateSpyStep((p) => userUpdates.push(p)),// 3. users.premium_until update
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111, 100)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    expect(userUpdates).toHaveLength(1)
    const until = new Date(userUpdates[0].premium_until).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
    // posts the ops notice with buyer/duration/amount/charge on confirmed grant
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0]
    expect(notice).toContain('💎 Premium purchased')
    expect(notice).toContain('30 days')
    expect(notice).toContain('100 ⭐')
    expect(notice).toContain('charge_1')
    // congratulates the buyer by DM, in the buyer's language
    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, 'en')
  })

  it('DMs a buyer without a stored locale in Persian (null)', async () => {
    scriptDb([
      claimStep(PAID_TX),
      lookupStep({ premium_until: null, locale: null }),
      updateSpyStep(() => {}),
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111, 100)
    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, null)
  })

  it('still grants premium when the buyer DM fails', async () => {
    vi.mocked(notifyPremiumPurchased).mockRejectedValueOnce(new Error('blocked'))
    const userUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep({ premium_until: null }),
      updateSpyStep((p) => userUpdates.push(p)),
    ])
    await expect(handlePremiumPaid('tx1', 'charge_1', 111, 100)).resolves.toBeUndefined()
    expect(userUpdates).toHaveLength(1)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
  })

  it('is idempotent on replays (claim misses)', async () => {
    scriptDb([claimStep(null)])
    await handlePremiumPaid('tx1', 'charge_1', 111, 100)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('refunds and marks refunded when the user update fails', async () => {
    const txUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep({ premium_until: null }),
      updateSpyStep(() => {}, { message: 'db down' }), // users update errors
      updateSpyStep((p) => txUpdates.push(p)),         // tx -> refunded
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111, 100)
    expect(refundPremiumPayment).toHaveBeenCalledWith(111, 'charge_1')
    expect(txUpdates[0]).toMatchObject({ status: 'refunded' })
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('refunds when the user row is missing', async () => {
    const txUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep(null),                        // user gone
      updateSpyStep((p) => txUpdates.push(p)), // tx -> refunded
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111, 100)
    expect(refundPremiumPayment).toHaveBeenCalledWith(111, 'charge_1')
    expect(txUpdates[0]).toMatchObject({ status: 'refunded' })
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
  })
})
