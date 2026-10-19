import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', () => ({
  getPremiumStatus: vi.fn(), createPremiumCheckout: vi.fn(), getPremiumTransactionStatus: vi.fn(),
  changeTonPaysCard: vi.fn(), submitTonPaysRefundCard: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import {
  getPremiumStatus, createPremiumCheckout, getPremiumTransactionStatus,
  changeTonPaysCard, submitTonPaysRefundCard,
} from '../src/premium/service.js'

function auth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: 'u1' } }) }) }) } as any)
}

describe('premium routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

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
    expect(getPremiumStatus).toHaveBeenCalledWith('u1')
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

  it('change-card returns the new card and maps the cooldown error to 429', async () => {
    auth()
    vi.mocked(changeTonPaysCard).mockResolvedValue({ ok: true, cardNumber: '6037-2222', cardHolder: 'New Holder' })
    const ok = await app.inject({ method: 'POST', url: '/premium/transactions/tx1/change-card', headers: { authorization: 'x' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ cardNumber: '6037-2222', cardHolder: 'New Holder' })
    expect(changeTonPaysCard).toHaveBeenCalledWith('tx1', 'u1')

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

  it('refund-card validates card number and forwards to tonpays', async () => {
    auth()
    vi.mocked(submitTonPaysRefundCard).mockResolvedValue({ ok: true })
    const res = await app.inject({
      method: 'POST', url: '/premium/transactions/tx1/refund-card', headers: { authorization: 'x' },
      payload: { cardNumber: '6037 9911 2233 4455', cardHolder: 'Ali' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(submitTonPaysRefundCard).toHaveBeenCalledWith('tx1', 'u1', '6037 9911 2233 4455', 'Ali')
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
})
