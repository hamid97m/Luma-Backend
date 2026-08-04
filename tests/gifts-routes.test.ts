import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/gifts/service.js', () => ({
  getCatalogForBuyer: vi.fn(), createGiftCheckout: vi.fn(), getTransactionStatus: vi.fn(),
  listPendingIntros: vi.fn(), acceptIntro: vi.fn(), dismissIntro: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { createGiftCheckout } from '../src/gifts/service.js'

function auth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: 'u1' } }) }) }) } as any)
}

describe('gifts routes auth guard', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/gifts/catalog' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /gifts/checkout', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('returns the invoice link', async () => {
    auth()
    vi.mocked(createGiftCheckout).mockResolvedValue({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/abc' })
    const res = await app.inject({
      method: 'POST', url: '/gifts/checkout', headers: { authorization: 'x' },
      payload: { context: 'chat', matchId: 'm1', giftId: 'g1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/abc' })
  })

  it('rejects a bad context', async () => {
    auth()
    const res = await app.inject({
      method: 'POST', url: '/gifts/checkout', headers: { authorization: 'x' },
      payload: { context: 'nope', giftId: 'g1' },
    })
    expect(res.statusCode).toBe(400)
  })
})
