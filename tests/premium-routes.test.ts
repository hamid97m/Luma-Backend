import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/premium/service.js', () => ({
  getPremiumStatus: vi.fn(), createPremiumCheckout: vi.fn(), getPremiumTransactionStatus: vi.fn(),
  changeTonPaysCard: vi.fn(), submitTonPaysRefundCard: vi.fn(),
}))
vi.mock('../src/premium/storePurchase.js', async () => ({
  ...(await vi.importActual<typeof import('../src/premium/storePurchase.js')>('../src/premium/storePurchase.js')),
  verifyStorePurchase: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { authAs } from './helpers/auth.js'
import { resetDb, createUser } from './helpers/db.js'
import {
  getPremiumStatus, createPremiumCheckout, getPremiumTransactionStatus,
  changeTonPaysCard, submitTonPaysRefundCard,
} from '../src/premium/service.js'
import { verifyStorePurchase } from '../src/premium/storePurchase.js'

describe('premium routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  const auth = () => authAs(me)
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    me = await createUser({ name: 'Ali' })
    app = await buildApp()
  })

  it('401s without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/premium/status' })
    expect(res.statusCode).toBe(401)
  })

  it('returns premium status', async () => {
    auth()
    vi.mocked(getPremiumStatus).mockResolvedValue({ enabled: true, premiumUntil: null, plans: [] })
    const res = await app.inject({ method: 'GET', url: '/premium/status', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, premiumUntil: null, plans: [] })
    expect(getPremiumStatus).toHaveBeenCalledWith(me.id)
  })

  it('checkout requires planId', async () => {
    auth()
    const res = await app.inject({ method: 'POST', url: '/premium/checkout', headers: { authorization: 'x' }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('checkout returns the invoice link', async () => {
    auth()
    vi.mocked(createPremiumCheckout).mockResolvedValue({ transactionId: 'tx1', invoiceLink: 'https://t.me/i' })
    const res = await app.inject({
      method: 'POST', url: '/premium/checkout', headers: { authorization: 'x' }, payload: { planId: 'p1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/i' })
  })

  it('checkout maps service errors to 400', async () => {
    auth()
    vi.mocked(createPremiumCheckout).mockResolvedValue({ error: 'premium_disabled' })
    const res = await app.inject({
      method: 'POST', url: '/premium/checkout', headers: { authorization: 'x' }, payload: { planId: 'p1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'premium_disabled' })
  })

  it('transaction status 404s for foreign/unknown tx', async () => {
    auth()
    vi.mocked(getPremiumTransactionStatus).mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/premium/transactions/tx9', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(404)
  })

  it('polling the transaction endpoint has its own rate-limit bucket and does not exhaust the global 300/hour budget', async () => {
    // The TonPays payment step polls this route every 5s for up to 10 minutes
    // (120 requests per attempt). Under the global limiter that would eat 40%
    // of the user's hourly budget and 429 the rest of the app mid-payment.
    auth()
    vi.mocked(getPremiumTransactionStatus).mockResolvedValue({ status: 'pending_payment', provider: 'tonpays' })

    const headers = { authorization: 'same-user-token' }
    for (let i = 0; i < 305; i++) {
      const res = await app.inject({ method: 'GET', url: '/premium/transactions/tx1', headers })
      expect(res.statusCode).toBe(200) // never 429, even past the global max of 300
    }

    // ...and the rest of the app is still usable for that same user.
    const status = await app.inject({ method: 'GET', url: '/premium/status', headers })
    expect(status.statusCode).not.toBe(429)
  })

  it('change-card returns the new card and maps the cooldown error to 429', async () => {
    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: true, cardNumber: '6037-2222', cardHolder: 'New Holder' })
    const ok = await app.inject({ method: 'POST', url: '/premium/transactions/tx1/change-card', headers: { authorization: 'x' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ cardNumber: '6037-2222', cardHolder: 'New Holder' })
    expect(changeTonPaysCard).toHaveBeenCalledWith('tx1', me.id)

    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: false, code: 'cooldown' })
    const cooldown = await app.inject({ method: 'POST', url: '/premium/transactions/tx1/change-card', headers: { authorization: 'x' } })
    expect(cooldown.statusCode).toBe(429)
    expect(cooldown.json()).toEqual({ error: 'change_card_cooldown' })
  })

  it('change-card maps an upstream error to a non-429 failure', async () => {
    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: false, code: 'upstream_error' })
    const res = await app.inject({ method: 'POST', url: '/premium/transactions/tx1/change-card', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'tonpays_unavailable' })
  })

  it('change-card maps a non-cooldown 4xx (invalid_request) to 400', async () => {
    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: false, code: 'invalid_request' })
    const res = await app.inject({ method: 'POST', url: '/premium/transactions/tx1/change-card', headers: { authorization: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'change_card_failed' })
  })

  it('refund-card validates card number and forwards to tonpays', async () => {
    auth()
    vi.mocked(submitTonPaysRefundCard).mockResolvedValue({ ok: true })
    const res = await app.inject({
      method: 'POST', url: '/premium/transactions/tx1/refund-card', headers: { authorization: 'x' },
      payload: { cardNumber: '6037 9911 2233 4455', cardHolder: 'Ali' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(submitTonPaysRefundCard).toHaveBeenCalledWith('tx1', me.id, '6037 9911 2233 4455', 'Ali')
  })

  it('refund-card maps invalid_card to 400', async () => {
    auth()
    vi.mocked(submitTonPaysRefundCard).mockResolvedValue({ ok: false, code: 'invalid_card' })
    const res = await app.inject({
      method: 'POST', url: '/premium/transactions/tx1/refund-card', headers: { authorization: 'x' },
      payload: { cardNumber: '123', cardHolder: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('change-card and refund-card both 404 for another user or a stars tx', async () => {
    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: false, code: 'not_found' })
    const r1 = await app.inject({ method: 'POST', url: '/premium/transactions/tx9/change-card', headers: { authorization: 'x' } })
    expect(r1.statusCode).toBe(404)

    auth()
    vi.mocked(submitTonPaysRefundCard).mockResolvedValue({ ok: false, code: 'not_found' })
    const r2 = await app.inject({
      method: 'POST', url: '/premium/transactions/tx9/refund-card', headers: { authorization: 'x' },
      payload: { cardNumber: '6037991122334455', cardHolder: 'Ali' },
    })
    expect(r2.statusCode).toBe(404)
  })

  describe('POST /premium/store-purchase', () => {
    const post = (payload: unknown) => app.inject({
      method: 'POST', url: '/premium/store-purchase', headers: { authorization: 'x' }, payload: payload as any,
    })
    const body = { store: 'myket', sku: 'premium_1m', purchaseToken: 'tok_1' }

    it('401 without auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/premium/store-purchase', payload: body })
      expect(res.statusCode).toBe(401)
      expect(verifyStorePurchase).not.toHaveBeenCalled()
    })

    it('400 on missing/oversized fields or unknown store', async () => {
      for (const bad of [
        {}, { ...body, store: 'googleplay' }, { ...body, sku: '' }, { ...body, sku: '   ' },
        { ...body, purchaseToken: undefined }, { ...body, purchaseToken: 'x'.repeat(257) },
        { ...body, sku: 42 },
      ]) {
        auth()
        const res = await post(bad)
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'invalid_input' })
      }
      expect(verifyStorePurchase).not.toHaveBeenCalled()
    })

    it('200 with the result and passes the caller id + trimmed fields', async () => {
      auth()
      vi.mocked(verifyStorePurchase).mockResolvedValue({ ok: true, already: false, premiumUntil: '2026-12-13T00:00:00.000Z' })
      const res = await post({ ...body, sku: ' premium_1m ' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, already: false, premiumUntil: '2026-12-13T00:00:00.000Z' })
      expect(verifyStorePurchase).toHaveBeenCalledWith(me.id, 'myket', 'premium_1m', 'tok_1')
    })

    it.each([
      ['unknown_sku', 400], ['invalid_input', 400], ['purchase_invalid', 402], ['payload_mismatch', 403],
      ['token_used', 409], ['grant_failed', 500], ['store_unavailable', 502], ['store_not_configured', 503],
    ] as const)('maps %s to %i', async (error, status) => {
      auth()
      vi.mocked(verifyStorePurchase).mockResolvedValue({ error })
      const res = await post(body)
      expect(res.statusCode).toBe(status)
      expect(res.json()).toEqual({ error })
    })
  })
})
