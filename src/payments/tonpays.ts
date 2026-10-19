// TonPays (Iranian card-to-card payment gateway) API client + webhook
// signature verification. Pure/stateless aside from reading env vars at call
// time (so tests can stub them) and making network calls — no db/bot deps,
// matching the style of paymentNotify.ts, so the request/response shapes are
// unit-testable in isolation.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const SIGNATURE_TOLERANCE_SECONDS = 600
const ORDER_ID_LENGTH = 20
const ORDER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export type TonPaysInvoice = {
  invoiceId: string
  cardNumber: string
  cardHolder: string
  finalAmount: number
  status: string
}

export type TonPaysCheck = {
  invoiceId: string
  status: string
  paid: boolean
  remainingAmount: number | null
  refundPending: boolean
}

export class TonPaysApiError extends Error {
  code: string
  httpStatus: number

  constructor(code: string, message: string, httpStatus: number) {
    super(message)
    this.name = 'TonPaysApiError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** True iff a TonPays API key is configured. */
export function isTonPaysConfigured(): boolean {
  return !!process.env.TONPAYS_API_KEY
}

/**
 * Verifies a TonPays webhook signature header of the form
 * `t=<unix seconds>,v1=<hex HMAC-SHA256>`, where the HMAC is computed over
 * `"{t}." + raw_body` using `secret`. Rejects (returns false, never throws)
 * on a missing/malformed header, a signature mismatch, or a timestamp more
 * than SIGNATURE_TOLERANCE_SECONDS away from `nowMs` (default: Date.now()).
 */
export function verifyTonPaysSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!header) return false

  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const idx = part.indexOf('=')
      return idx === -1 ? [part, ''] : [part.slice(0, idx), part.slice(idx + 1)]
    }),
  )
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false

  const tSeconds = Number(t)
  if (!Number.isFinite(tSeconds)) return false
  if (Math.abs(nowMs / 1000 - tSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  const expectedHex = createHmac('sha256', secret).update(`${tSeconds}.${body}`).digest('hex')

  const expected = Buffer.from(expectedHex, 'hex')
  const actual = Buffer.from(v1, 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** Generates a random 20-char lowercase-alphanumeric order id. */
export function generateTonPaysOrderId(): string {
  const bytes = randomBytes(ORDER_ID_LENGTH)
  let id = ''
  for (let i = 0; i < ORDER_ID_LENGTH; i++) {
    id += ORDER_ID_ALPHABET[bytes[i] % ORDER_ID_ALPHABET.length]
  }
  return id
}

function baseUrl(): string {
  return process.env.TONPAYS_BASE_URL || 'https://tonpays.online'
}

/** Shared fetch helper: applies base URL + X-API-Key, parses JSON, and maps error responses to TonPaysApiError. */
async function tonpaysFetch<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.TONPAYS_API_KEY ?? '',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    const detail = data?.detail
    throw new TonPaysApiError(detail?.code ?? 'UNKNOWN_ERROR', detail?.message ?? `tonpays_http_${res.status}`, res.status)
  }

  return data as T
}

export async function createTelegramInvoice(p: {
  amountToman: number
  orderId: string
  buyerChatId: number
}): Promise<TonPaysInvoice> {
  const data = await tonpaysFetch<any>('/api/custom/v1/invoices/telegram/create', {
    method: 'POST',
    body: {
      amount: p.amountToman,
      order_id: p.orderId,
      buyer_chat_id: p.buyerChatId,
      callback_url: process.env.TONPAYS_CALLBACK_URL,
    },
  })

  return {
    invoiceId: data.invoice_id,
    cardNumber: data.card_number,
    cardHolder: data.card_holder,
    finalAmount: data.final_amount,
    status: data.status,
  }
}

export async function checkInvoice(invoiceId: string): Promise<TonPaysCheck> {
  const data = await tonpaysFetch<any>(`/api/v1/invoices/check/${invoiceId}`, { method: 'GET' })

  return {
    invoiceId: data.invoice_id,
    status: data.status,
    paid: data.paid,
    remainingAmount: data.remaining_amount,
    refundPending: data.refund_pending,
  }
}

/** Cancels a pending invoice. Swallows a 409 (already non-pending); throws any other error. */
export async function cancelInvoice(invoiceId: string): Promise<void> {
  try {
    await tonpaysFetch<unknown>(`/api/v1/invoices/${invoiceId}/cancel`, { method: 'POST' })
  } catch (err) {
    if (err instanceof TonPaysApiError && err.httpStatus === 409) return
    throw err
  }
}

export async function changeCard(invoiceId: string): Promise<{ cardNumber: string; cardHolder: string }> {
  const data = await tonpaysFetch<any>(`/api/custom/v1/invoices/${invoiceId}/change-card`, { method: 'POST' })
  return { cardNumber: data.card_number, cardHolder: data.card_holder }
}

export async function submitRefundCard(invoiceId: string, cardNumber: string, cardHolder: string): Promise<void> {
  await tonpaysFetch<unknown>(`/api/v1/invoices/${invoiceId}/refund`, {
    method: 'POST',
    body: { card_number: cardNumber, card_holder: cardHolder },
  })
}
