import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/notify/userNotify.js', () => ({
  notifyUserPremiumPurchased: vi.fn().mockResolvedValue('bot'),
}))
vi.mock('../src/payments/myket.js', () => ({
  isMyketConfigured: vi.fn(() => true),
  verifyMyketPurchase: vi.fn(),
}))
vi.mock('../src/payments/bazaar.js', () => ({
  isBazaarConfigured: vi.fn(() => true),
  verifyBazaarPurchase: vi.fn(),
}))
import { notifyPaymentChannel } from '../src/bot.js'
import { notifyUserPremiumPurchased } from '../src/notify/userNotify.js'
import { isMyketConfigured, verifyMyketPurchase } from '../src/payments/myket.js'
import { verifyBazaarPurchase } from '../src/payments/bazaar.js'
import { StoreUnavailableError } from '../src/payments/storeTypes.js'
import { verifyStorePurchase } from '../src/premium/storePurchase.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { createPlan, setPremiumConfig, failPremiumUntilUpdates, restoreUserUpdates } from './helpers/premium.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SKU = 'premium_1m'
const TOKEN = 'tok_abc'

const premiumUntilOf = async (userId: string) =>
  (await sql`select premium_until from users where id = ${userId}`)[0].premium_until as string | null
const storeRows = () => sql`select * from premium_transactions where provider in ('bazaar','myket') order by created_at`

const purchased = (payload: string | null) => ({ status: 'purchased' as const, payload, purchaseTime: Date.now() })

describe('verifyStorePurchase', () => {
  let me: Record<string, any>
  let plan: Record<string, any>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(isMyketConfigured).mockReturnValue(true)
    await resetDb()
    me = await createUser({ name: 'Ali', locale: 'fa' })
    plan = await createPlan({
      title: '1 Month', duration_days: 30, myket_sku: SKU, myket_price_toman: 120000,
      bazaar_sku: 'baz_1m', bazaar_price_toman: 110000,
    })
    vi.mocked(verifyMyketPurchase).mockResolvedValue(purchased(me.id))
    vi.mocked(verifyBazaarPurchase).mockResolvedValue(purchased(me.id))
  })
  afterEach(async () => { await restoreUserUpdates() })

  it('grants premium, records a paid myket row with price_toman, store_sku, token, price_stars 0', async () => {
    const res = await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    expect(res).toMatchObject({ ok: true, already: false })
    expect(verifyMyketPurchase).toHaveBeenCalledWith(SKU, TOKEN)

    const rows = await storeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: me.id, provider: 'myket', source: 'purchase', status: 'paid', plan_id: plan.id,
      plan_title: '1 Month', duration_days: 30, price_stars: 0, price_toman: 120000,
      store_sku: SKU, store_purchase_token: TOKEN,
    })
    expect(rows[0].paid_at).not.toBeNull()

    const until = new Date((await premiumUntilOf(me.id))!).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29.9 * DAY_MS)
    expect(until).toBeLessThan(Date.now() + 30.1 * DAY_MS)
    expect((res as any).premiumUntil).toBe(await premiumUntilOf(me.id))

    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0] as string
    expect(notice).toContain('Myket')
    expect(notice).toContain('120,000 Toman')
    expect(notice).not.toContain(TOKEN)
    expect(notifyUserPremiumPurchased).toHaveBeenCalledWith(
      expect.objectContaining({ id: me.id, telegram_id: me.telegram_id }), 30,
    )
  })

  it('uses the bazaar client and bazaar price for bazaar purchases', async () => {
    const res = await verifyStorePurchase(me.id, 'bazaar', 'baz_1m', TOKEN)
    expect(res).toMatchObject({ ok: true, already: false })
    expect(verifyBazaarPurchase).toHaveBeenCalledWith('baz_1m', TOKEN)
    expect(verifyMyketPurchase).not.toHaveBeenCalled()
    const [row] = await storeRows()
    expect(row).toMatchObject({ provider: 'bazaar', price_toman: 110000, store_sku: 'baz_1m' })
  })

  it('records a null price_toman when the plan has no store price', async () => {
    await sql`update premium_plans set myket_price_toman = null where id = ${plan.id}`
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toMatchObject({ ok: true })
    const [row] = await storeRows()
    expect(row.price_toman).toBeNull()
  })

  it('extends an existing active premium rather than resetting it', async () => {
    const current = new Date(Date.now() + 10 * DAY_MS).toISOString()
    await sql`update users set premium_until = ${current} where id = ${me.id}`
    await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    const until = new Date((await premiumUntilOf(me.id))!).getTime()
    expect(until).toBe(new Date(current).getTime() + 30 * DAY_MS)
  })

  it('same user resubmits the token → 200 already:true, no second extension', async () => {
    await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    const first = await premiumUntilOf(me.id)
    vi.mocked(verifyMyketPurchase).mockClear()

    const res = await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    expect(res).toEqual({ ok: true, already: true, premiumUntil: first })
    expect(verifyMyketPurchase).not.toHaveBeenCalled()
    expect(await premiumUntilOf(me.id)).toBe(first)
    expect(await storeRows()).toHaveLength(1)
  })

  it('two concurrent submits of one token → one row, one extension', async () => {
    const [a, b] = await Promise.all([
      verifyStorePurchase(me.id, 'myket', SKU, TOKEN),
      verifyStorePurchase(me.id, 'myket', SKU, TOKEN),
    ])
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true })
    expect([(a as any).already, (b as any).already].sort()).toEqual([false, true])
    expect(await storeRows()).toHaveLength(1)
    const until = new Date((await premiumUntilOf(me.id))!).getTime()
    expect(until).toBeLessThan(Date.now() + 30.1 * DAY_MS)
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
  })

  it('the same token on a different store is a separate purchase', async () => {
    await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    const res = await verifyStorePurchase(me.id, 'bazaar', 'baz_1m', TOKEN)
    expect(res).toMatchObject({ ok: true, already: false })
    expect(await storeRows()).toHaveLength(2)
  })

  it('another user submits a used token → 409 token_used', async () => {
    await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)
    const other = await createUser({ name: 'Reza' })
    vi.mocked(verifyMyketPurchase).mockResolvedValue(purchased(other.id))
    expect(await verifyStorePurchase(other.id, 'myket', SKU, TOKEN)).toEqual({ error: 'token_used' })
    expect(await premiumUntilOf(other.id)).toBeNull()
    expect(await storeRows()).toHaveLength(1)
  })

  it('payload of another user → 403 payload_mismatch, nothing written', async () => {
    const other = await createUser({ name: 'Reza' })
    vi.mocked(verifyMyketPurchase).mockResolvedValue(purchased(other.id))
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'payload_mismatch' })
    expect(await storeRows()).toHaveLength(0)
    expect(await premiumUntilOf(me.id)).toBeNull()
  })

  it('empty payload → granted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(verifyMyketPurchase).mockResolvedValue(purchased(null))
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toMatchObject({ ok: true, already: false })
    expect(await storeRows()).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).not.toContain(TOKEN)
    warn.mockRestore()
  })

  it('store says invalid → 402', async () => {
    vi.mocked(verifyMyketPurchase).mockResolvedValue({ status: 'invalid' })
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'purchase_invalid' })
    expect(await storeRows()).toHaveLength(0)
  })

  it('store throws StoreUnavailableError → 502, nothing written', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(verifyMyketPurchase).mockRejectedValue(new StoreUnavailableError('myket responded 503'))
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'store_unavailable' })
    expect(await storeRows()).toHaveLength(0)
    expect(await premiumUntilOf(me.id)).toBeNull()
    err.mockRestore()
  })

  it('store not configured → 503', async () => {
    vi.mocked(isMyketConfigured).mockReturnValue(false)
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'store_not_configured' })
    expect(verifyMyketPurchase).not.toHaveBeenCalled()
  })

  it('unknown sku → 400 unknown_sku', async () => {
    expect(await verifyStorePurchase(me.id, 'myket', 'nope', TOKEN)).toEqual({ error: 'unknown_sku' })
    // a bazaar sku is not a myket sku
    expect(await verifyStorePurchase(me.id, 'myket', 'baz_1m', TOKEN)).toEqual({ error: 'unknown_sku' })
    expect(verifyMyketPurchase).not.toHaveBeenCalled()
  })

  it('sku of an inactive plan → granted', async () => {
    await sql`update premium_plans set is_active = false where id = ${plan.id}`
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toMatchObject({ ok: true, already: false })
    expect(await storeRows()).toHaveLength(1)
  })

  it('premium globally disabled → still granted (the user already paid)', async () => {
    await setPremiumConfig({ premium_enabled: false })
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toMatchObject({ ok: true, already: false })
  })

  it('invalid input → invalid_input', async () => {
    expect(await verifyStorePurchase(me.id, 'googleplay' as any, SKU, TOKEN)).toEqual({ error: 'invalid_input' })
    expect(await verifyStorePurchase(me.id, 'myket', '  ', TOKEN)).toEqual({ error: 'invalid_input' })
    expect(await verifyStorePurchase(me.id, 'myket', SKU, 'x'.repeat(257))).toEqual({ error: 'invalid_input' })
    expect(await verifyStorePurchase(me.id, 'myket', SKU, 42 as any)).toEqual({ error: 'invalid_input' })
  })

  it('trims sku and token', async () => {
    expect(await verifyStorePurchase(me.id, 'myket', ` ${SKU} `, ` ${TOKEN} `)).toMatchObject({ ok: true })
    expect(verifyMyketPurchase).toHaveBeenCalledWith(SKU, TOKEN)
    const [row] = await storeRows()
    expect(row.store_purchase_token).toBe(TOKEN)
  })

  it('grant failure rolls back the transaction row → 500 grant_failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await failPremiumUntilUpdates('boom')
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'grant_failed' })
    expect(await storeRows()).toHaveLength(0)
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyUserPremiumPurchased).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('user deleted between verify and grant → 500 grant_failed, nothing written', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(verifyMyketPurchase).mockImplementation(async () => {
      await sql`delete from users where id = ${me.id}`
      return purchased(me.id)
    })
    expect(await verifyStorePurchase(me.id, 'myket', SKU, TOKEN)).toEqual({ error: 'grant_failed' })
    expect(await storeRows()).toHaveLength(0)
    err.mockRestore()
  })
})
