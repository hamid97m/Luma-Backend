import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/payments/tonpays.js', () => ({
  isTonPaysConfigured: vi.fn(() => true),
  checkInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
}))
vi.mock('../src/premium/service.js', () => ({
  handleTonPaysPaid: vi.fn(),
}))

import { db } from '../src/db.js'
import { isTonPaysConfigured, checkInvoice, cancelInvoice } from '../src/payments/tonpays.js'
import { handleTonPaysPaid } from '../src/premium/service.js'
import { runTonPaysSweepJob } from '../src/jobs/tonpaysSweep.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any

type UpdateCall = { patch: any; matchers: Array<[string, any]> }

/**
 * Mock db.from('premium_transactions') query builder.
 *
 * Distinguishes the two selects the job issues by which range-filter method is
 * called last: `.lte(...)` with no accompanying `.lt(...)` marks the ancient
 * (>48h) cleanup scan; `.lt(...)` (+`.gt(...)`) marks the checkable (10m-48h)
 * window scan. `.limit(n)` truncates the relevant fixture array, so the cap
 * is exercised for real rather than merely asserted on the call args.
 * `.update(...)` returns a chainable that records EVERY `.eq`/`.in` matcher
 * in call order (so both the row-identity matcher and the `status =
 * 'pending_payment'` idempotency guard show up), resolving once awaited.
 */
function buildDb(opts: { checkable?: any[]; ancient?: any[] }) {
  const updates: UpdateCall[] = []
  const fromCalls: string[] = []

  const from = vi.fn((table: string) => {
    fromCalls.push(table)
    let mode: 'ancient' | 'checkable' | null = null
    const q: any = {
      select: () => q,
      eq: () => q,
      lte: () => { mode = 'ancient'; return q },
      lt: () => { mode = 'checkable'; return q },
      gt: () => q,
      order: () => q,
      limit: (n: number) => {
        const source = mode === 'ancient' ? (opts.ancient ?? []) : (opts.checkable ?? [])
        return Promise.resolve({ data: source.slice(0, n), error: null })
      },
      update: (patch: any) => {
        const matchers: Array<[string, any]> = []
        const uq: any = {
          eq: (col: string, val: any) => { matchers.push([col, val]); return uq },
          in: (col: string, val: any) => { matchers.push([col, val]); return uq },
          then: (resolve: any, reject: any) => {
            updates.push({ patch, matchers })
            return Promise.resolve({ error: null }).then(resolve, reject)
          },
        }
        return uq
      },
    }
    return q
  })

  return { from, updates, fromCalls }
}

const hasMatcher = (u: UpdateCall, col: string, val: any) =>
  u.matchers.some(([c, v]) => c === col && (Array.isArray(v) ? v.includes(val) : v === val))

beforeEach(() => {
  vi.mocked(isTonPaysConfigured).mockReturnValue(true)
  vi.mocked(checkInvoice).mockReset()
  vi.mocked(cancelInvoice).mockReset()
  vi.mocked(cancelInvoice).mockResolvedValue(undefined)
  vi.mocked(handleTonPaysPaid).mockReset()
  vi.mocked(db.from).mockReset()
  log.info.mockReset(); log.warn.mockReset(); log.error.mockReset()
})

describe('runTonPaysSweepJob', () => {
  it('no-ops without TONPAYS_API_KEY', async () => {
    vi.mocked(isTonPaysConfigured).mockReturnValue(false)
    const mockDb = buildDb({})
    vi.mocked(db.from).mockImplementation(mockDb.from as any)

    await runTonPaysSweepJob({ log })

    expect(mockDb.from).not.toHaveBeenCalled()
    expect(checkInvoice).not.toHaveBeenCalled()
    expect(handleTonPaysPaid).not.toHaveBeenCalled()
  })

  it('grants a paid invoice found by the sweep', async () => {
    const mockDb = buildDb({ checkable: [{ id: 'tx1', tonpays_invoice_id: 'inv1' }] })
    vi.mocked(db.from).mockImplementation(mockDb.from as any)
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv1', status: 'paid', paid: true,
      remainingAmount: 0, refundPending: false, cardNumber: null, cardHolder: null,
    })
    vi.mocked(handleTonPaysPaid).mockResolvedValue('granted')

    await runTonPaysSweepJob({ log })

    expect(checkInvoice).toHaveBeenCalledWith('inv1')
    expect(handleTonPaysPaid).toHaveBeenCalledWith('inv1')
    // A paid row is finalized entirely inside handleTonPaysPaid — the sweep
    // itself issues no separate status update for it.
    expect(mockDb.updates.find((u) => hasMatcher(u, 'id', 'tx1'))).toBeUndefined()
  })

  it('cancels expired rows and ancient rows without checking the ancient ones, guarding both updates on pending_payment', async () => {
    const mockDb = buildDb({
      checkable: [{ id: 'tx-expired', tonpays_invoice_id: 'inv-expired' }],
      ancient: [{ id: 'tx-ancient', tonpays_invoice_id: 'inv-ancient' }],
    })
    vi.mocked(db.from).mockImplementation(mockDb.from as any)
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv-expired', status: 'expired', paid: false,
      remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await runTonPaysSweepJob({ log })

    // Only the checkable row's invoice was ever checked upstream.
    expect(checkInvoice).toHaveBeenCalledTimes(1)
    expect(checkInvoice).toHaveBeenCalledWith('inv-expired')

    const expiredUpdate = mockDb.updates.find((u) => hasMatcher(u, 'id', 'tx-expired'))
    expect(expiredUpdate?.patch).toEqual({ status: 'canceled', tonpays_status: 'expired' })
    // Guard: the per-row expired/canceled update must not clobber a row that
    // paid between the SELECT and this UPDATE.
    expect(hasMatcher(expiredUpdate!, 'status', 'pending_payment')).toBe(true)

    const ancientUpdate = mockDb.updates.find((u) => hasMatcher(u, 'id', 'tx-ancient'))
    expect(ancientUpdate?.patch).toEqual({ status: 'canceled' })
    // Guard: the ancient batch cancel must not clobber a row that paid
    // between the SELECT and this UPDATE either.
    expect(hasMatcher(ancientUpdate!, 'status', 'pending_payment')).toBe(true)

    // An ancient row's invoice must also be cancelled UPSTREAM: TonPays allows
    // one pending invoice per buyer, so leaving it live would block that buyer
    // from ever checking out again.
    expect(cancelInvoice).toHaveBeenCalledWith('inv-ancient')
  })

  it('cancels an ancient row locally even when the upstream cancel fails, and keeps going across rows', async () => {
    const mockDb = buildDb({
      ancient: [
        { id: 'tx-a', tonpays_invoice_id: 'inv-a' },
        { id: 'tx-b', tonpays_invoice_id: null }, // never got an invoice — nothing upstream
        { id: 'tx-c', tonpays_invoice_id: 'inv-c' },
      ],
    })
    vi.mocked(db.from).mockImplementation(mockDb.from as any)
    vi.mocked(cancelInvoice).mockRejectedValueOnce(new Error('tonpays down'))

    await runTonPaysSweepJob({ log })

    // The first row's failure must not stop the second invoice's cancel...
    expect(cancelInvoice).toHaveBeenCalledTimes(2)
    expect(cancelInvoice).toHaveBeenCalledWith('inv-a')
    expect(cancelInvoice).toHaveBeenCalledWith('inv-c')
    expect(log.warn).toHaveBeenCalled()
    // ...and the local cancel still has to happen, or these rows get re-swept forever.
    const batch = mockDb.updates.find((u) => hasMatcher(u, 'id', 'tx-a'))
    expect(batch?.patch).toEqual({ status: 'canceled' })
    expect(hasMatcher(batch!, 'id', 'tx-c')).toBe(true)
  })

  it('caps at 30 checks per run', async () => {
    const checkable = Array.from({ length: 40 }, (_, i) => ({ id: `tx${i}`, tonpays_invoice_id: `inv${i}` }))
    const mockDb = buildDb({ checkable })
    vi.mocked(db.from).mockImplementation(mockDb.from as any)
    vi.mocked(checkInvoice).mockResolvedValue({
      invoiceId: 'inv', status: 'pending', paid: false,
      remainingAmount: null, refundPending: false, cardNumber: null, cardHolder: null,
    })

    await runTonPaysSweepJob({ log })

    expect(checkInvoice).toHaveBeenCalledTimes(30)
  })
})
