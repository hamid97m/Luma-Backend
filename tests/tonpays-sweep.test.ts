import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/payments/tonpays.js', () => ({
  isTonPaysConfigured: vi.fn(() => true),
  checkInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
}))
vi.mock('../src/premium/service.js', () => ({
  handleTonPaysPaid: vi.fn(),
}))

import { resetDb, createUser, sql } from './helpers/db.js'
import { createTx, getTx, ago } from './helpers/premium.js'
import { isTonPaysConfigured, checkInvoice, cancelInvoice } from '../src/payments/tonpays.js'
import { handleTonPaysPaid } from '../src/premium/service.js'
import { runTonPaysSweepJob } from '../src/jobs/tonpaysSweep.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** A pending TonPays tx created `ageMs` ago. */
async function pendingTx(ageMs: number, inv: string | null, overrides: Record<string, unknown> = {}) {
  const u = await createUser()
  return createTx(u.id, {
    provider: 'tonpays', tonpays_invoice_id: inv, created_at: ago(ageMs), ...overrides,
  })
}

beforeEach(async () => {
  await resetDb()
  vi.mocked(isTonPaysConfigured).mockReturnValue(true)
  vi.mocked(checkInvoice).mockReset()
  vi.mocked(cancelInvoice).mockReset()
  vi.mocked(cancelInvoice).mockResolvedValue(undefined)
  vi.mocked(handleTonPaysPaid).mockReset()
  log.info.mockReset(); log.warn.mockReset(); log.error.mockReset()
})

describe('runTonPaysSweepJob', () => {
  it('no-ops without TONPAYS_API_KEY', async () => {
    vi.mocked(isTonPaysConfigured).mockReturnValue(false)
    const ancient = await pendingTx(49 * HOUR, 'inv-ancient')
    await pendingTx(20 * MIN, 'inv1')

    await runTonPaysSweepJob({ log })

    expect((await getTx(ancient.id)).status).toBe('pending_payment')
    expect(checkInvoice).not.toHaveBeenCalled()
    expect(cancelInvoice).not.toHaveBeenCalled()
    expect(handleTonPaysPaid).not.toHaveBeenCalled()
  })

  it('grants a paid invoice found by the sweep', async () => {
    const tx = await pendingTx(20 * MIN, 'inv1')
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'paid', paid: true,
      remainingAmount: 0, refundPending: false, cardNumber: null, cardHolder: null,
    })
    vi.mocked(handleTonPaysPaid).mockResolvedValue('granted')

    await runTonPaysSweepJob({ log })

    expect(checkInvoice).toHaveBeenCalledWith('inv1')
    expect(handleTonPaysPaid).toHaveBeenCalledWith('inv1')
    // A paid row is finalized entirely inside handleTonPaysPaid (mocked here) —
    // the sweep itself issues no separate status update for it.
    expect((await getTx(tx.id)).status).toBe('pending_payment')
  })

  it('only checks rows inside the 10m–48h window, skipping rows with no invoice and non-tonpays/non-pending rows', async () => {
    await pendingTx(5 * MIN, 'inv-young')                         // too young
    await pendingTx(20 * MIN, null)                               // never got an invoice
    await pendingTx(20 * MIN, 'inv-stars', { provider: 'stars' })  // not tonpays
    await pendingTx(20 * MIN, 'inv-paid', { status: 'paid' })      // already resolved
    await pendingTx(30 * MIN, 'inv-ok')
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-ok', status: 'pending', paid: false,
      remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await runTonPaysSweepJob({ log })

    expect(vi.mocked(checkInvoice).mock.calls).toEqual([['inv-ok']])
  })

  it('cancels expired rows and ancient rows without checking the ancient ones, guarding both updates on pending_payment', async () => {
    const expired = await pendingTx(20 * MIN, 'inv-expired')
    const ancient = await pendingTx(49 * HOUR, 'inv-ancient')
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-expired', status: 'expired', paid: false,
      remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await runTonPaysSweepJob({ log })

    // Only the checkable row's invoice was ever checked upstream.
    expect(checkInvoice).toHaveBeenCalledTimes(1)
    expect(checkInvoice).toHaveBeenCalledWith('inv-expired')

    expect(await getTx(expired.id)).toMatchObject({ status: 'canceled', tonpays_status: 'expired' })
    expect(await getTx(ancient.id)).toMatchObject({ status: 'canceled', tonpays_status: null })

    // An ancient row's invoice must also be cancelled UPSTREAM: TonPays allows
    // one pending invoice per buyer, so leaving it live would block that buyer
    // from ever checking out again.
    expect(cancelInvoice).toHaveBeenCalledWith('inv-ancient')
  })

  it('never clobbers a row that got paid between the SELECT and the cancel (expired path)', async () => {
    const tx = await pendingTx(20 * MIN, 'inv-race')
    // The webhook grant lands while the upstream check is in flight.
    vi.mocked(checkInvoice).mockImplementation(async () => {
      await sql`update premium_transactions set status = 'paid' where id = ${tx.id}`
      return {
        invoiceId: 'inv-race', status: 'expired', paid: false,
        remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
      }
    })

    await runTonPaysSweepJob({ log })

    expect(await getTx(tx.id)).toMatchObject({ status: 'paid', tonpays_status: null })
  })

  it('never clobbers an ancient row that got paid between the SELECT and the batch cancel', async () => {
    const tx = await pendingTx(49 * HOUR, 'inv-race')
    vi.mocked(cancelInvoice).mockImplementation(async () => {
      await sql`update premium_transactions set status = 'paid' where id = ${tx.id}`
    })

    await runTonPaysSweepJob({ log })

    expect((await getTx(tx.id)).status).toBe('paid')
  })

  it('cancels an ancient row locally even when the upstream cancel fails, and keeps going across rows', async () => {
    const a = await pendingTx(50 * HOUR, 'inv-a')
    const b = await pendingTx(50 * HOUR, null) // never got an invoice — nothing upstream
    const c = await pendingTx(50 * HOUR, 'inv-c')
    vi.mocked(cancelInvoice).mockRejectedValueOnce(new Error('tonpays down'))

    await runTonPaysSweepJob({ log })

    // The first row's failure must not stop the second invoice's cancel...
    expect(cancelInvoice).toHaveBeenCalledTimes(2)
    expect(cancelInvoice).toHaveBeenCalledWith('inv-a')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-c')
    expect(log.warn).toHaveBeenCalled()
    // ...and the local cancel still has to happen, or these rows get re-swept forever.
    for (const tx of [a, b, c]) expect((await getTx(tx.id)).status).toBe('canceled')
  })

  it('a failing upstream check on one row is logged and does not stop the rest', async () => {
    await pendingTx(40 * MIN, 'inv-bad')
    const ok = await pendingTx(30 * MIN, 'inv-ok')
    vi.mocked(checkInvoice)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        invoiceId: 'inv-ok', status: 'canceled', paid: false,
        remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
      })

    await runTonPaysSweepJob({ log })

    expect(log.warn).toHaveBeenCalled()
    expect(await getTx(ok.id)).toMatchObject({ status: 'canceled', tonpays_status: 'canceled' })
  })

  it('caps at 30 checks per run, oldest first', async () => {
    for (let i = 0; i < 40; i++) await pendingTx((20 + i) * MIN, `inv${i}`)
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv', status: 'pending', paid: false,
      remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await runTonPaysSweepJob({ log })

    expect(checkInvoice).toHaveBeenCalledTimes(30)
    expect(vi.mocked(checkInvoice).mock.calls[0]).toEqual(['inv39']) // ascending created_at
  })
})
