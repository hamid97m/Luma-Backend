import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  createPremiumInvoiceLink: vi.fn(),
  refundPremiumPayment: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  notifyPremiumPurchased: vi.fn().mockResolvedValue(undefined),
}))

const SECRET = 'test_webhook_secret'
process.env.TONPAYS_WEBHOOK_SECRET = SECRET

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
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

/** Claim step: update -> eq -> eq -> select -> maybeSingle, returning `data`. */
function claimStep(data: any) {
  return { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data }) }) }) }) }) }
}
/** Lookup step: select -> eq -> single/maybeSingle, returning `data`. */
function lookupStep(data: any) {
  const leaf = { single: () => ({ data }), maybeSingle: () => ({ data }) }
  return { select: () => ({ eq: () => leaf }) }
}
/** update() spy step: captures the payload, then eq() resolves with `error`/`data`. */
function updateSpyStep(spy: (payload: any) => void, error: any = null) {
  return { update: (payload: any) => { spy(payload); return { eq: () => ({ error, data: null }) } } }
}
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

const PAID_TX = { id: 'tx1', user_id: 'u1', duration_days: 30, price_toman: 300000, tonpays_final_amount: 300037 }
const BUYER = { premium_until: null, name: 'Ali', locale: 'en', telegram_id: 111 }

describe('POST /payments/tonpays/webhook', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('401s on missing or invalid signature', async () => {
    const noSig = await inject(app, 'invoice.completed', { invoice_id: 'inv1' }, { signature: null })
    expect(noSig.statusCode).toBe(401)

    const badSig = await inject(app, 'invoice.completed', { invoice_id: 'inv1' }, { signature: 't=1,v1=' + 'a'.repeat(64) })
    expect(badSig.statusCode).toBe(401)

    expect(db.from).not.toHaveBeenCalled()
  })

  it('grants premium once on invoice.completed', async () => {
    const userUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),                 // 1. pending -> paid claim
      lookupStep(BUYER),                  // 2. buyer lookup
      updateSpyStep((p) => userUpdates.push(p)), // 3. users.premium_until update
    ])

    const res = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(res.statusCode).toBe(200)

    expect(userUpdates).toHaveLength(1)
    const until = new Date(userUpdates[0].premium_until).getTime()
    expect(until).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)

    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0]
    expect(notice).toContain('💎 Premium purchased (TonPays)')
    expect(notice).toContain('30 days')
    expect(notice).toContain('300037 Toman')
    expect(notice).toContain('inv1')

    expect(notifyPremiumPurchased).toHaveBeenCalledWith(111, 30, 'en')
  })

  it('is idempotent on duplicate delivery', async () => {
    const userUpdates: any[] = []
    scriptDb([
      claimStep(PAID_TX),
      lookupStep(BUYER),
      updateSpyStep((p) => userUpdates.push(p)),
      claimStep(null),                    // replay: already paid, claim misses
      lookupStep({ id: 'tx1' }),          // but the invoice is known
    ])

    const first = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(first.statusCode).toBe(200)

    const second = await inject(app, 'invoice.completed', { invoice_id: 'inv1', status: 'completed' })
    expect(second.statusCode).toBe(200)

    expect(userUpdates).toHaveLength(1)
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    expect(notifyPremiumPurchased).toHaveBeenCalledTimes(1)
  })

  it('200s and touches nothing for an unknown invoice', async () => {
    scriptDb([
      claimStep(null),                    // no pending row for this invoice
      lookupStep(null),                   // and no row at all — truly unknown
    ])

    const res = await inject(app, 'invoice.completed', { invoice_id: 'ghost', status: 'completed' })
    expect(res.statusCode).toBe(200)

    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('updates tonpays_status on non-completed events', async () => {
    const updates: any[] = []
    scriptDb([
      updateSpyStep((p) => updates.push(p)),
    ])

    const res = await inject(app, 'invoice.action_required_less', { invoice_id: 'inv2', status: 'action_required_less' })
    expect(res.statusCode).toBe(200)

    expect(updates).toEqual([{ tonpays_status: 'action_required_less' }])
    expect(notifyPaymentChannel).not.toHaveBeenCalled()
    expect(notifyPremiumPurchased).not.toHaveBeenCalled()
  })

  it('does not require initData auth', async () => {
    scriptDb([updateSpyStep(() => {})])
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
})
