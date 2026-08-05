import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/service.js', () => ({
  getPremiumStatus: vi.fn(), createPremiumCheckout: vi.fn(), getPremiumTransactionStatus: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getPremiumStatus, createPremiumCheckout, getPremiumTransactionStatus } from '../src/premium/service.js'

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
})
