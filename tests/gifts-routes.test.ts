import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/gifts/service.js', () => ({
  getCatalogForBuyer: vi.fn(), createGiftCheckout: vi.fn(), getTransactionStatus: vi.fn(),
  listPendingIntros: vi.fn(), acceptIntro: vi.fn(), dismissIntro: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { createGiftCheckout, acceptIntro } from '../src/gifts/service.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser } from './helpers/db.js'

let me: Record<string, any>
let app: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali' })
})

describe('gifts routes auth guard', () => {
  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/gifts/catalog' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /gifts/checkout', () => {
  it('returns the invoice link', async () => {
    authAs(me)
    vi.mocked(createGiftCheckout).mockResolvedValue({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/abc' })
    const res = await app.inject({
      method: 'POST', url: '/gifts/checkout', headers: AUTH,
      payload: { context: 'chat', matchId: 'm1', giftId: 'g1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ transactionId: 'tx1', invoiceLink: 'https://t.me/invoice/abc' })
    expect(createGiftCheckout).toHaveBeenCalledWith(expect.objectContaining({ buyerId: me.id }))
  })

  it('rejects a bad context', async () => {
    authAs(me)
    const res = await app.inject({
      method: 'POST', url: '/gifts/checkout', headers: AUTH,
      payload: { context: 'nope', giftId: 'g1' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /gifts/intros/:id/accept', () => {
  it('returns the matchId on success', async () => {
    authAs(me)
    vi.mocked(acceptIntro).mockResolvedValue({ matchId: 'match1' })
    const res = await app.inject({ method: 'POST', url: '/gifts/intros/tx1/accept', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matchId: 'match1' })
  })

  it('returns 400 buyer_unavailable when the buyer account is gone', async () => {
    authAs(me)
    vi.mocked(acceptIntro).mockResolvedValue({ error: 'buyer_unavailable' })
    const res = await app.inject({ method: 'POST', url: '/gifts/intros/tx1/accept', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'buyer_unavailable' })
  })
})
