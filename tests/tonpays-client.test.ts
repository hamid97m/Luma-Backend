import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

import {
  isTonPaysConfigured,
  verifyTonPaysSignature,
  generateTonPaysOrderId,
  TonPaysApiError,
  createTelegramInvoice,
  checkInvoice,
  cancelInvoice,
  changeCard,
  submitRefundCard,
} from '../src/payments/tonpays.js'

const SECRET = 'whsec_test_secret'

function sign(body: string, t: number, secret = SECRET) {
  const hex = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${hex}`
}

describe('isTonPaysConfigured', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is true iff TONPAYS_API_KEY is non-empty', () => {
    vi.stubEnv('TONPAYS_API_KEY', '')
    expect(isTonPaysConfigured()).toBe(false)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
    expect(isTonPaysConfigured()).toBe(true)
  })
})

describe('verifyTonPaysSignature', () => {
  const body = JSON.stringify({ invoice_id: 'abc', status: 'paid' })
  const nowMs = Date.parse('2026-01-01T00:00:00Z')
  const nowSec = Math.floor(nowMs / 1000)

  it('accepts a valid signature', () => {
    const header = sign(body, nowSec)
    expect(verifyTonPaysSignature(body, header, SECRET, nowMs)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    const header = sign(body, nowSec, 'wrong-secret')
    expect(verifyTonPaysSignature(body, header, SECRET, nowMs)).toBe(false)
  })

  it('rejects a stale timestamp', () => {
    const staleT = nowSec - 601
    const header = sign(body, staleT)
    expect(verifyTonPaysSignature(body, header, SECRET, nowMs)).toBe(false)
  })

  it('rejects malformed or missing header without throwing', () => {
    expect(verifyTonPaysSignature(body, undefined, SECRET, nowMs)).toBe(false)
    expect(verifyTonPaysSignature(body, '', SECRET, nowMs)).toBe(false)
    expect(verifyTonPaysSignature(body, 'garbage', SECRET, nowMs)).toBe(false)
    expect(verifyTonPaysSignature(body, 't=1', SECRET, nowMs)).toBe(false)
  })

  it('verifies correctly when t has a leading zero, signing over the raw header string', () => {
    // nowSec happens to not start with 0, so pick a stale-looking but still-fresh
    // raw t string with a leading zero to prove the HMAC is computed over the raw
    // string "0<digits>", not over Number("0<digits>") re-serialized without the zero.
    const rawT = `0${nowSec}`
    const hex = createHmac('sha256', SECRET).update(`${rawT}.${body}`).digest('hex')
    const header = `t=${rawT},v1=${hex}`
    expect(verifyTonPaysSignature(body, header, SECRET, nowMs)).toBe(true)
  })
})

describe('generateTonPaysOrderId', () => {
  it('is 20 chars of [a-z0-9] and unique across 100 calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const id = generateTonPaysOrderId()
      expect(id).toMatch(/^[a-z0-9]{20}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(100)
  })
})

describe('createTelegramInvoice', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
    vi.stubEnv('TONPAYS_CALLBACK_URL', 'https://api.example/tonpays/webhook')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('maps a success response to TonPaysInvoice, preferring card_name for the holder', async () => {
    // Real shape confirmed live in Task 10: the create endpoint returns
    // `card_name`, not `card_holder`, for the holder name.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      order_id: 'order-1',
      request_amount: 150000,
      card_number: '6037-xxxx-xxxx-1234',
      card_name: 'John Doe',
      final_amount: 150000,
      status: 'pending',
      show_change_card: true,
    }), { status: 200 }))

    const result = await createTelegramInvoice({ amountToman: 150000, orderId: 'order-1', buyerChatId: 42 })

    expect(result).toEqual({
      invoiceId: 'inv-1',
      cardNumber: '6037-xxxx-xxxx-1234',
      cardHolder: 'John Doe',
      finalAmount: 150000,
      status: 'pending',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://tonpays.online/api/custom/v1/invoices/telegram/create')
    expect(init.method).toBe('POST')
    expect(init.headers['X-API-Key']).toBe('key-123')
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      amount: 150000,
      order_id: 'order-1',
      buyer_chat_id: 42,
      callback_url: 'https://api.example/tonpays/webhook',
    })
  })

  it('falls back to card_holder for the holder when card_name is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      card_number: '6037-xxxx-xxxx-1234',
      card_holder: 'Jane Doe',
      final_amount: 150000,
      status: 'pending',
    }), { status: 200 }))

    const result = await createTelegramInvoice({ amountToman: 150000, orderId: 'order-1', buyerChatId: 42 })
    expect(result.cardHolder).toBe('Jane Doe')
  })

  it('throws TonPaysApiError with the detail.code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      detail: { code: 'BUYER_HAS_PENDING_INVOICE', message: 'Buyer already has a pending invoice' },
    }), { status: 409 }))

    const call = createTelegramInvoice({ amountToman: 150000, orderId: 'order-1', buyerChatId: 42 })
    await expect(call).rejects.toBeInstanceOf(TonPaysApiError)
    await expect(call).rejects.toMatchObject({ code: 'BUYER_HAS_PENDING_INVOICE', httpStatus: 409 })
  })

  it('maps an unparsable (e.g. HTML gateway-error) body on a non-2xx response to TonPaysApiError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    }))

    const call = createTelegramInvoice({ amountToman: 150000, orderId: 'order-1', buyerChatId: 42 })
    await expect(call).rejects.toBeInstanceOf(TonPaysApiError)
    await expect(call).rejects.toMatchObject({ httpStatus: 502 })
  })
})

describe('checkInvoice', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('hits /api/custom/v1/invoices/check/{id} (confirmed live in Task 10 — the ' +
     'generic /api/v1/ path 403s WRONG_API_KEY_KIND for a custom_tg-kind key) and maps ' +
     'a real pending-invoice payload (no card fields) to null cardNumber/cardHolder', async () => {
    // Exact shape observed live against a real, never-changed pending invoice.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      order_id: 'order-1',
      request_amount: 50000,
      final_amount: 50234,
      status: 'pending',
      paid: false,
      buyer_username: null,
      show_change_card: true,
      change_card_cooldown_seconds: 0,
      change_card_exhausted: false,
      status_label: 'Awaiting payment',
      need_action_kind: null,
      remaining_amount: null,
      remaining_invoice_id: null,
      remaining_card_number: null,
      remaining_card_holder: null,
      remaining_receipt_received: false,
      refund_amount: null,
      reject_reasons: [],
      refund_pending: false,
    }), { status: 200 }))

    const result = await checkInvoice('inv-1')

    expect(result).toEqual({
      invoiceId: 'inv-1',
      status: 'pending',
      paid: false,
      remainingAmount: null,
      refundPending: false,
      cardNumber: null,
      cardHolder: null,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://tonpays.online/api/custom/v1/invoices/check/inv-1')
    expect(init.method).toBe('GET')
    expect(init.headers['X-API-Key']).toBe('key-123')
  })

  it('maps a canceled invoice (confirmed live shape in Task 10)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      status: 'canceled',
      paid: false,
      status_label: 'Canceled',
      remaining_amount: null,
      refund_pending: false,
    }), { status: 200 }))

    const result = await checkInvoice('inv-1')
    expect(result.status).toBe('canceled')
    expect(result.paid).toBe(false)
  })

  it('prefers card_name over card_holder when both are present (tolerant fallback kept)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      status: 'pending',
      paid: false,
      remaining_amount: null,
      refund_pending: false,
      card_number: '6037-xxxx-xxxx-1234',
      card_name: 'John Doe',
      card_holder: 'Should Not Win',
    }), { status: 200 }))

    const result = await checkInvoice('inv-1')

    expect(result).toEqual({
      invoiceId: 'inv-1',
      status: 'pending',
      paid: false,
      remainingAmount: null,
      refundPending: false,
      cardNumber: '6037-xxxx-xxxx-1234',
      cardHolder: 'John Doe',
    })
  })

  it('falls back to card_holder for the holder when card_name is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      status: 'pending',
      paid: false,
      remaining_amount: null,
      refund_pending: false,
      card_number: '6037-xxxx-xxxx-1234',
      card_holder: 'Jane Doe',
    }), { status: 200 }))

    const result = await checkInvoice('inv-1')

    expect(result.cardHolder).toBe('Jane Doe')
  })
})

describe('cancelInvoice', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('hits /api/custom/v1/invoices/{id}/cancel (confirmed live in Task 10 — the ' +
     'generic /api/v1/ path 403s WRONG_API_KEY_KIND for a custom_tg-kind key) and ' +
     'swallows 409, throws on 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      detail: { code: 'INVOICE_NOT_PENDING', message: 'already settled' },
    }), { status: 409 }))
    await expect(cancelInvoice('inv-1')).resolves.toBeUndefined()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://tonpays.online/api/custom/v1/invoices/inv-1/cancel')
    expect(init.method).toBe('POST')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      detail: { code: 'INTERNAL_ERROR', message: 'boom' },
    }), { status: 500 }))
    await expect(cancelInvoice('inv-1')).rejects.toBeInstanceOf(TonPaysApiError)
  })

  it('still swallows a 409 whose body is unparsable garbage', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 409 }))
    await expect(cancelInvoice('inv-1')).resolves.toBeUndefined()
  })

  it('maps a real canceled-invoice response shape after a live cancel (Task 10)', async () => {
    // Confirms cancelInvoice doesn't choke on the real response body (it
    // discards the body either way, but this is the exact shape TonPays
    // returned on a successful cancel in the live round-trip).
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      invoice_id: 'inv-1',
      status: 'canceled',
      paid: false,
      status_label: 'Canceled',
    }), { status: 200 }))
    await expect(cancelInvoice('inv-1')).resolves.toBeUndefined()
  })
})

describe('changeCard', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('maps a success response to the new card, preferring card_name for the holder', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      card_number: '6037-xxxx-xxxx-9999',
      card_name: 'Jane Doe',
    }), { status: 200 }))

    const result = await changeCard('inv-1')

    expect(result).toEqual({ cardNumber: '6037-xxxx-xxxx-9999', cardHolder: 'Jane Doe' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://tonpays.online/api/custom/v1/invoices/inv-1/change-card')
    expect(init.method).toBe('POST')
  })

  it('falls back to card_holder for the holder when card_name is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      card_number: '6037-xxxx-xxxx-9999',
      card_holder: 'Jane Doe',
    }), { status: 200 }))

    const result = await changeCard('inv-1')
    expect(result.cardHolder).toBe('Jane Doe')
  })
})

describe('submitRefundCard', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TONPAYS_API_KEY', 'key-123')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('posts the refund card to /api/custom/v1/ (by analogy with checkInvoice/cancelInvoice ' +
     '— NOT itself live-tested, see code comment) and resolves on success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await expect(submitRefundCard('inv-1', '6037-xxxx-xxxx-1111', 'John Doe')).resolves.toBeUndefined()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://tonpays.online/api/custom/v1/invoices/inv-1/refund')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toEqual({ card_number: '6037-xxxx-xxxx-1111', card_holder: 'John Doe' })
  })
})
