import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))

const SECRET = 'test_webhook_secret'
process.env.TONPAYS_WEBHOOK_SECRET = SECRET

import { buildApp } from '../src/server.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { createTx, getTx } from './helpers/premium.js'
import { notifyPaymentChannel, notifyPremiumPurchased } from '../src/bot.js'

const URL = '/payments/tonpays/webhook'

function sign(body: string, tSeconds = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac('sha256', SECRET).update(`${tSeconds}.${body}`).digest('hex')
  return `t=${tSeconds},v1=${hex}`
}

function inject(app: Awaited<ReturnType<typeof buildApp>>, event: string, body: Record<string, unknown>, opts: { signature?: string | null } = {}) {
  const payload = JSON.stringify(body)
  const signature = opts.signature === null ? undefined : (opts.signature ?? sign(payload))
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-tonpays-event': event }
  if (signature) headers['x-tonpays-signature'] = signature
  return app.inject({ method: 'POST', url: URL, headers, payload })
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A pending TonPays tx for invoice `inv` belonging to a fresh buyer. */
async function pendingTonPaysTx(inv: string) {
  const buyer = await createUser({ name: 'Ali', locale: 'en', telegram_id: 111 })
  const tx = await createTx(buyer.id, {
    provider: 'tonpays', tonpays_invoice_id: inv, price_toman: 300000, tonpays_final_amount: 300037,
  })
  return { buyer, tx }
}

const premiumUntilOf = async (userId: string) =>
  (await sql`select premium_until from users where id = ${userId}`)[0].premium_until as string | null

describe('POST /payments/tonpays/webhook', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    app = await buildApp()
  })

  it('401s on missing or invalid signature', async () => {
    await pendingTonPaysTx('inv1')
    const noSig = await inject(app, 'invoice.completed', { invoice_id: 'inv1' }, { signature: null })
    expect(noSig.statusCode).toBe(401)

    const badSig = await inject(app, 'invoice.completed', { invoice_id: 'inv1' }, { signature: 't=1,v1=' + 'a'.repeat(64) })
    expect(badSig.statusCode).toBe(401)

    expect((await sql`select status from premium_transactions`)[0].status).toBe('pending_payment')
  })

  it('401s without touching the db when no webhook secret is configured', async () => {
    // The attack this closes: with an empty secret the HMAC key is one the
    // attacker also knows, so a self-signed {"invoice_id": "<own invoice>"}
    // body would otherwise verify and grant premium for free.
    vi.stubEnv('TONPAYS_WEBHOOK_SECRET', '')
    const { buyer } = await pendingTonPaysTx('inv1')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const payload = JSON.stringify({ invoice_id: 'inv1' })
      const tSeconds = Math.floor(Date.now() / 1000)
      const hex = createHmac('sha256', '').update(`${tSeconds}.${payload}`).digest('hex')
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: {
          'content-type': 'application/json',
          'x-tonpays-event': 'invoice.completed',
          'x-tonpays-signature': `t=${tSeconds},v1=${hex}`,
        },
        payload,
      })

      expect(res.statusCode).toBe(401)
      expect((await sql`select status from premium_transactions`)[0].status).toBe('pending_payment')
      expect(await premiumUntilOf(buyer.id)).toBeNull()
      expect(errSpy).toHaveBeenCalled() // misconfiguration is logged loudly
    } finally {
      errSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('grants premium once on invoice.completed', async () => {
    const { buyer, tx } = await pendingTonPaysTx('inv1')

    const res = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(res.statusCode).toBe(200)

    const row = await getTx(tx.id)
    expect(row.status).toBe('paid')
    expect(row.paid_at).not.toBeNull()
    const until = new Date((await premiumUntilOf(buyer.id))!).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29 * DAY_MS)

    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0]
    expect(notice).toContain('💎 Premium purchased (TonPays)')
    expect(notice).toContain('30 days')
    expect(notice).toContain('300037 Toman')
    expect(notice).toContain('inv1')

    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, 'en')
  })

  it('is idempotent on duplicate delivery', async () => {
    const { buyer } = await pendingTonPaysTx('inv1')

    const first = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(first.statusCode).toBe(200)
    const afterFirst = await premiumUntilOf(buyer.id)

    const second = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(second.statusCode).toBe(200)

    expect(await premiumUntilOf(buyer.id)).toBe(afterFirst) // the replay granted nothing more
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    expect(notifyPremiumPurchased).toHaveBeenCalledTimes(1)
  })

  it('200s, touches nothing and logs a warning for an unknown invoice', async () => {
    const { buyer } = await pendingTonPaysTx('inv1') // some other, unrelated invoice
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await inject(app, 'invoice.completed', { invoice_id: 'ghost', status: 'completed' })
    expect(res.statusCode).toBe(200)

    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
    expect(await premiumUntilOf(buyer.id)).toBeNull()
    // The route is logLevel:'silent', so a completed event that granted
    // nothing must still leave a trace somewhere.
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('not_found')
    warnSpy.mockRestore()
  })

  it('updates tonpays_status on non-completed events', async () => {
    const { buyer, tx } = await pendingTonPaysTx('inv2')

    const res = await inject(app, 'invoice.action_required_less', { invoice_id: 'inv2', status: 'action_required_less' })
    expect(res.statusCode).toBe(200)

    const row = await getTx(tx.id)
    expect(row.tonpays_status).toBe('action_required_less')
    expect(row.status).toBe('pending_payment') // a status sync never grants or cancels
    expect(await premiumUntilOf(buyer.id)).toBeNull()
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('does not require initData auth', async () => {
    const payload = JSON.stringify({ invoice_id: 'inv3', status: 'canceled' })
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: {
        'content-type': 'application/json',
        'x-tonpays-event': 'invoice.canceled',
        'x-tonpays-signature': sign(payload),
      },
      payload,
    })
    expect(res.statusCode).toBe(200)
  })

  it('a non-completed event for an unknown invoice is a 200 no-op', async () => {
    const { tx } = await pendingTonPaysTx('inv1')
    const res = await inject(app, 'invoice.canceled', { invoice_id: 'ghost', status: 'canceled' })
    expect(res.statusCode).toBe(200)
    expect((await getTx(tx.id)).tonpays_status).toBeNull()
  })

  it('invoice.completed for an already-canceled row does not grant (claim needs pending_payment)', async () => {
    const { buyer, tx } = await pendingTonPaysTx('inv1')
    await sql`update premium_transactions set status = 'canceled' where id = ${tx.id}`
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })

    expect(res.statusCode).toBe(200)
    expect((await getTx(tx.id)).status).toBe('canceled')
    expect(await premiumUntilOf(buyer.id)).toBeNull()
    warnSpy.mockRestore()
  })
})
