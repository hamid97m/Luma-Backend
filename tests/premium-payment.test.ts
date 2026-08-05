import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { refundPremiumPayment } from '../src/bot.js'
import { validatePremiumPreCheckout, handlePremiumPaid } from '../src/premium/service.js'

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

describe('validatePremiumPreCheckout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a pending tx with matching amount', async () => {
    scriptDb([lookupStep({ status: 'pending_payment', price_stars: 100 })])
    expect(await validatePremiumPreCheckout('tx1', 100, 'XTR')).toEqual({ ok: true })
  })
  it('rejects an unknown tx', async () => {
    scriptDb([lookupStep(null)])
    expect((await validatePremiumPreCheckout('tx1', 100, 'XTR')).ok).toBe(false)
  })
  it('rejects an already-processed tx', async () => {
    scriptDb([lookupStep({ status: 'paid', price_stars: 100 })])
    expect((await validatePremiumPreCheckout('tx1', 100, 'XTR')).ok).toBe(false)
  })
  it('rejects an amount mismatch', async () => {
    scriptDb([lookupStep({ status: 'pending_payment', price_stars: 100 })])
    expect((await validatePremiumPreCheckout('tx1', 50, 'XTR')).ok).toBe(false)
  })
})

describe('handlePremiumPaid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims the tx and extends premium_until', async () => {
    const userUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),                       // 1. pending -> paid claim
      lookupStep({ premium_until: null }),      // 2. current expiry lookup
      updateSpyStep((p) => userUpdates.push(p)),// 3. users.premium_until update
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    expect(userUpdates).toHaveLength(1)
    const until = new Date(userUpdates[0].premium_until).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
  })

  it('is idempotent on replays (claim misses)', async () => {
    scriptDb([claimStep(null)])
    await handlePremiumPaid('tx1', 'charge_1', 111)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
  })

  it('refunds and marks refunded when the user update fails', async () => {
    const txUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep({ premium_until: null }),
      updateSpyStep(() => {}, { message: 'db down' }), // users update errors
      updateSpyStep((p) => txUpdates.push(p)),         // tx -> refunded
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111)
    expect(refundPremiumPayment).toHaveBeenCalledWith(111, 'charge_1')
    expect(txUpdates[0]).toMatchObject({ status: 'refunded' })
  })

  it('refunds when the user row is missing', async () => {
    const txUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep(null),                        // user gone
      updateSpyStep((p) => txUpdates.push(p)), // tx -> refunded
    ])
    await handlePremiumPaid('tx1', 'charge_1', 111)
    expect(refundPremiumPayment).toHaveBeenCalledWith(111, 'charge_1')
    expect(txUpdates[0]).toMatchObject({ status: 'refunded' })
  })
})
