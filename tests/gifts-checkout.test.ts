import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(),
  createGiftInvoiceLink: vi.fn().mockResolvedValue('https://t.me/invoice/abc'),
  sendGiftToUser: vi.fn(), refundGift: vi.fn(), notifyNewMessage: vi.fn(), notifyGiftIntro: vi.fn(),
  notifyPaymentChannel: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { getGiftCatalog, createGiftInvoiceLink } from '../src/bot.js'
import { en } from '../src/i18n/en.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'
import { createGiftTx } from './helpers/gifts-referrals.js'

// Real service + real DB end to end through the routes (gifts-routes.test.ts covers
// the route layer with the service mocked).
let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let her: Record<string, any>

beforeEach(async () => {
  await resetDb()
  vi.mocked(getGiftCatalog).mockResolvedValue([{ id: 'rose', sticker: { emoji: '🌹' }, star_count: 15 }] as any)
  vi.mocked(createGiftInvoiceLink).mockResolvedValue('https://t.me/invoice/abc')
  app = await buildApp()
  me = await createUser({ name: 'Ali', locale: 'en' })
  her = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
  authAs(me)
})

const checkout = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/gifts/checkout', headers: AUTH, payload })

describe('POST /gifts/checkout (real service)', () => {
  it('chat gift: inserts a pending_payment tx with the marked-up price and returns the invoice', async () => {
    const match = await createMatch(me.id, her.id)
    const res = await checkout({ context: 'chat', matchId: match.id, giftId: 'rose', note: '  hi  ' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.invoiceLink).toBe('https://t.me/invoice/abc')

    const [tx] = await sql`select * from gift_transactions where id = ${body.transactionId}`
    expect(tx).toMatchObject({
      buyer_id: me.id, recipient_id: her.id, context: 'chat', match_id: match.id,
      gift_id: 'rose', gift_emoji: '🌹', gift_star_cost: 15, charged_stars: 20, markup_stars: 5,
      note: 'hi', status: 'pending_payment',
    })
    // Invoice copy in the buyer's language.
    expect(createGiftInvoiceLink).toHaveBeenCalledWith(body.transactionId, en.gifts.invoiceTitle('🌹'), en.gifts.invoiceDescription, 20)
  })

  it('discovery gift: honours a price override and stores no match_id', async () => {
    await insertRow('gift_price_overrides', { gift_id: 'rose', charged_stars: 30 })
    const res = await checkout({ context: 'discovery', targetUserId: her.id, giftId: 'rose' })
    expect(res.statusCode).toBe(200)
    const [tx] = await sql`select context, match_id, charged_stars, markup_stars, note from gift_transactions`
    expect(tx).toEqual({ context: 'discovery', match_id: null, charged_stars: 30, markup_stars: 15, note: null })
  })

  it('400 match_required / target_required when the id is missing', async () => {
    expect((await checkout({ context: 'chat', giftId: 'rose' })).json()).toEqual({ error: 'match_required' })
    expect((await checkout({ context: 'discovery', giftId: 'rose' })).json()).toEqual({ error: 'target_required' })
  })

  it('400 match_not_found for an unknown, foreign or malformed matchId', async () => {
    const other = await createUser()
    const foreign = await createMatch(her.id, other.id)
    for (const matchId of ['00000000-0000-0000-0000-000000000000', foreign.id, 'm1']) {
      const res = await checkout({ context: 'chat', matchId, giftId: 'rose' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'match_not_found' })
    }
  })

  it('400 recipient_unavailable for a deleted/banned recipient or a malformed targetUserId', async () => {
    const match = await createMatch(me.id, her.id)
    await sql`update users set banned_at = now() where id = ${her.id}`
    expect((await checkout({ context: 'chat', matchId: match.id, giftId: 'rose' })).json())
      .toEqual({ error: 'recipient_unavailable' })
    expect((await checkout({ context: 'discovery', targetUserId: her.id, giftId: 'rose' })).json())
      .toEqual({ error: 'recipient_unavailable' })
    expect((await checkout({ context: 'discovery', targetUserId: 'not-a-uuid', giftId: 'rose' })).json())
      .toEqual({ error: 'recipient_unavailable' })
  })

  it('400 cannot_gift_self and gift_unavailable', async () => {
    expect((await checkout({ context: 'discovery', targetUserId: me.id, giftId: 'rose' })).json())
      .toEqual({ error: 'cannot_gift_self' })
    expect((await checkout({ context: 'discovery', targetUserId: her.id, giftId: 'nope' })).json())
      .toEqual({ error: 'gift_unavailable' })
    expect(await sql`select id from gift_transactions`).toHaveLength(0)
  })
})

describe('GET /gifts/transactions/:id (real service)', () => {
  it('returns status for the buyer, 404 for anyone else, unknown or malformed ids', async () => {
    const tx = await createGiftTx(me.id, her.id, { status: 'sent', intro_status: 'pending' })
    const get = (id: string) => app.inject({ method: 'GET', url: `/gifts/transactions/${id}`, headers: AUTH })

    const ok = await get(tx.id)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ status: 'sent', introStatus: 'pending' })

    expect((await get('00000000-0000-0000-0000-000000000000')).statusCode).toBe(404)
    expect((await get('tx1')).statusCode).toBe(404)
    authAs(her)
    expect((await get(tx.id)).statusCode).toBe(404)
  })
})

describe('GET /gifts/intros + accept/dismiss (real service)', () => {
  it('lists, then a malformed id answers 400 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/gifts/intros', headers: AUTH })
    expect(res.json()).toEqual({ intros: [] })
    const bad = await app.inject({ method: 'POST', url: '/gifts/intros/xyz/dismiss', headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'not_found' })
  })
})
