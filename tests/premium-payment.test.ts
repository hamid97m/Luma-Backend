import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))
import { refundPremiumPayment, notifyPaymentChannel, notifyPremiumPurchased } from '../src/bot.js'
import { validatePremiumPreCheckout, handlePremiumPaid } from '../src/premium/service.js'
import { en } from '../src/i18n/en.js'
import { fa } from '../src/i18n/fa.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { createTx, getTx, failPremiumUntilUpdates, restoreUserUpdates } from './helpers/premium.js'

const DAY_MS = 24 * 60 * 60 * 1000
const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'

const premiumUntilOf = async (userId: string) =>
  (await sql`select premium_until from users where id = ${userId}`)[0].premium_until as string | null

describe('validatePremiumPreCheckout', () => {
  beforeEach(async () => { vi.clearAllMocks(); await resetDb() })

  it('accepts a pending tx with matching amount', async () => {
    const u = await createUser({ locale: 'fa' })
    const tx = await createTx(u.id, { price_stars: 100 })
    expect(await validatePremiumPreCheckout(tx.id, 100, 'XTR')).toEqual({ ok: true })
  })
  it('rejects an unknown tx in Persian (no buyer to look up)', async () => {
    expect(await validatePremiumPreCheckout(UNKNOWN_ID, 100, 'XTR'))
      .toEqual({ ok: false, reason: fa.premium.checkoutUnavailable })
  })
  it('rejects a malformed tx id as unknown (no 22P02 throw)', async () => {
    expect(await validatePremiumPreCheckout('not-a-uuid', 100, 'XTR'))
      .toEqual({ ok: false, reason: fa.premium.checkoutUnavailable })
  })
  it('rejects an already-processed tx in the buyer\'s language', async () => {
    const u = await createUser({ locale: 'en' })
    const tx = await createTx(u.id, { status: 'paid' })
    expect(await validatePremiumPreCheckout(tx.id, 100, 'XTR'))
      .toEqual({ ok: false, reason: en.premium.checkoutAlreadyProcessed })
  })
  it('rejects an amount mismatch in the buyer\'s language', async () => {
    const u = await createUser({ locale: 'en' })
    const tx = await createTx(u.id, { price_stars: 100 })
    expect(await validatePremiumPreCheckout(tx.id, 50, 'XTR'))
      .toEqual({ ok: false, reason: en.premium.checkoutPriceMismatch })
  })
  it('rejects a non-XTR currency', async () => {
    const u = await createUser({ locale: 'en' })
    const tx = await createTx(u.id, { price_stars: 100 })
    expect(await validatePremiumPreCheckout(tx.id, 100, 'USD'))
      .toEqual({ ok: false, reason: en.premium.checkoutPriceMismatch })
  })
  it('falls back to Persian when the buyer has no locale yet', async () => {
    const u = await createUser({ locale: null })
    const tx = await createTx(u.id, { price_stars: 100 })
    expect(await validatePremiumPreCheckout(tx.id, 50, 'XTR'))
      .toEqual({ ok: false, reason: fa.premium.checkoutPriceMismatch })
  })
})

describe('handlePremiumPaid', () => {
  beforeEach(async () => { vi.clearAllMocks(); await resetDb() })
  afterEach(async () => { await restoreUserUpdates() })

  it('claims the tx and extends premium_until', async () => {
    const u = await createUser({ locale: 'en', name: 'Ali' })
    const tx = await createTx(u.id, { duration_days: 30 })

    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)

    expect(refundPremiumPayment).not.toHaveBeenCalled()
    const row = await getTx(tx.id)
    expect(row.status).toBe('paid')
    expect(row.telegram_payment_charge_id).toBe('charge_1')
    expect(row.paid_at).not.toBeNull()
    const until = new Date((await premiumUntilOf(u.id))!).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29 * DAY_MS)
    expect(until).toBeLessThan(Date.now() + 31 * DAY_MS)
    // posts the ops notice with buyer/duration/amount/charge on confirmed grant
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0]
    expect(notice).toContain('💎 Premium purchased')
    expect(notice).toContain('Buyer: Ali')
    expect(notice).toContain('30 days')
    expect(notice).toContain('100 ⭐')
    expect(notice).toContain('charge_1')
    // congratulates the buyer by DM, in the buyer's language
    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, 'en')
  })

  it('stacks on top of a still-active premium_until', async () => {
    const current = new Date(Date.now() + 5 * DAY_MS).toISOString()
    const u = await createUser({ premium_until: current })
    const tx = await createTx(u.id, { duration_days: 30 })

    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)

    expect(await premiumUntilOf(u.id)).toBe(new Date(new Date(current).getTime() + 30 * DAY_MS).toISOString())
  })

  it('two concurrent grants for the same buyer both count (row lock, no lost update)', async () => {
    const u = await createUser()
    const a = await createTx(u.id, { duration_days: 30 })
    const b = await createTx(u.id, { duration_days: 7 })

    await Promise.all([handlePremiumPaid(a.id, 'ch_a', 111, 100), handlePremiumPaid(b.id, 'ch_b', 111, 100)])

    const until = new Date((await premiumUntilOf(u.id))!).getTime()
    expect(until).toBeGreaterThan(Date.now() + 36 * DAY_MS)
    expect(until).toBeLessThan(Date.now() + 38 * DAY_MS)
  })

  it('DMs a buyer without a stored locale in Persian (null)', async () => {
    const u = await createUser({ locale: null })
    const tx = await createTx(u.id)
    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)
    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, null)
  })

  it('still grants premium when the buyer DM fails', async () => {
    vi.mocked(notifyPremiumPurchased).mockRejectedValueOnce(new Error('blocked'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    const tx = await createTx(u.id)
    await expect(handlePremiumPaid(tx.id, 'charge_1', 111, 100)).resolves.toBeUndefined()
    expect(await premiumUntilOf(u.id)).not.toBeNull()
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('is idempotent on replays (claim misses)', async () => {
    const u = await createUser()
    const tx = await createTx(u.id)
    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)
    const firstUntil = await premiumUntilOf(u.id)
    vi.clearAllMocks()

    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)

    expect(await premiumUntilOf(u.id)).toBe(firstUntil) // not granted twice
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('concurrent duplicate deliveries grant exactly once', async () => {
    const u = await createUser()
    const tx = await createTx(u.id, { duration_days: 30 })
    await Promise.all([1, 2, 3].map(() => handlePremiumPaid(tx.id, 'charge_1', 111, 100)))
    const until = new Date((await premiumUntilOf(u.id))!).getTime()
    expect(until).toBeLessThan(Date.now() + 31 * DAY_MS)
    expect(notifyPremiumPurchased).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an unknown or malformed transaction id', async () => {
    await handlePremiumPaid('00000000-0000-0000-0000-000000000000', 'charge_1', 111, 100)
    await handlePremiumPaid('not-a-uuid', 'charge_1', 111, 100)
    expect(refundPremiumPayment).not.toHaveBeenCalled()
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
  })

  it('refunds and marks refunded when the user update fails', async () => {
    const u = await createUser()
    const tx = await createTx(u.id)
    await failPremiumUntilUpdates('db down')

    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)

    expect(refundPremiumPayment).toHaveBeenCalledWith(111, 'charge_1')
    expect((await getTx(tx.id)).status).toBe('refunded')
    expect(await premiumUntilOf(u.id)).toBeNull()
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('leaves the tx paid (for a manual refund) when the refund API itself fails', async () => {
    vi.mocked(refundPremiumPayment).mockRejectedValueOnce(new Error('tg down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    const tx = await createTx(u.id)
    await failPremiumUntilUpdates('db down')

    await handlePremiumPaid(tx.id, 'charge_1', 111, 100)

    const row = await getTx(tx.id)
    expect(row.status).toBe('paid')
    expect(row.telegram_payment_charge_id).toBe('charge_1')
    errSpy.mockRestore()
  })

  // "User row missing" can't be staged with real rows: premium_transactions.user_id
  // cascades on user delete, so a tx can't outlive its buyer. The refund path it
  // shares with the failed-update case is covered above.
})
