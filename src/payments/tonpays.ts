// TonPays (Iranian card-to-card payment gateway) API client + webhook
// signature verification. Pure/stateless aside from reading env vars at call
// time (so tests can stub them) and making network calls — no db/bot deps,
// matching the style of paymentNotify.ts, so the request/response shapes are
// unit-testable in isolation.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const SIGNATURE_TOLERANCE_SECONDS = 600
// Hard cap on every upstream call. A hung gateway would otherwise stall a
// buyer's checkout (undici's default is ~300s), stall the poll endpoint, and
// stretch one sequential sweep run far past its own cadence.
const REQUEST_TIMEOUT_MS = 15_000
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
  cardNumber: string | null
  cardHolder: string | null
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
 *
 * Fails closed on an empty `secret`: `createHmac('sha256', '')` is perfectly
 * legal in Node, so without this guard a missing/mistyped
 * TONPAYS_WEBHOOK_SECRET would verify any body an attacker signs with the
 * empty key they also know — i.e. a forgeable "grant me premium" endpoint.
 */
export function verifyTonPaysSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret) return false
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
  // Sign over the raw `t` string from the header, not the re-serialized number — a
  // non-canonical t (leading zero, '+') would otherwise silently fail to verify.
  const expectedHex = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')

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
  let res: Response
  let text: string
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.TONPAYS_API_KEY ?? '',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    text = await res.text()
  } catch (err) {
    // A timeout (or any abort mid-response) is surfaced as a TonPaysApiError
    // with httpStatus 0 so every caller's existing error handling applies —
    // instead of a bare AbortError/TimeoutError escaping as an unknown throw.
    const name = (err as Error | null)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new TonPaysApiError('TIMEOUT', `tonpays_request_timeout_${REQUEST_TIMEOUT_MS}ms`, 0)
    }
    throw err
  }

  let data: any = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // Hosted payment gateways can return an HTML/plaintext body on a gateway
      // error (502/503 from a proxy, etc). Map that to TonPaysApiError too, so
      // callers (and cancelInvoice's 409-swallow) never see a raw SyntaxError.
      throw new TonPaysApiError('INVALID_RESPONSE', `tonpays_invalid_json_http_${res.status}`, res.status)
    }
  }

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
    // Confirmed live (Task 10): the real create response carries the holder
    // name under `card_name`, not `card_holder` — `card_holder` never showed
    // up in a live payload but is kept as a fallback in case TonPays ever
    // sends it.
    cardHolder: data.card_name ?? data.card_holder,
    finalAmount: data.final_amount,
    status: data.status,
  }
}

export async function checkInvoice(invoiceId: string): Promise<TonPaysCheck> {
  // Confirmed live (Task 10): the generic /api/v1/invoices/check/{id} 403s
  // WRONG_API_KEY_KIND against a custom_tg-kind key (the owner's real key
  // kind). The working path for this key kind is under /api/custom/v1/.
  const data = await tonpaysFetch<any>(`/api/custom/v1/invoices/check/${invoiceId}`, { method: 'GET' })

  return {
    invoiceId: data.invoice_id,
    status: data.status,
    paid: data.paid,
    remainingAmount: data.remaining_amount,
    refundPending: data.refund_pending,
    // Confirmed live (Task 10): a still-pending, never-changed invoice's real
    // check response carries neither card_number/card_holder/card_name NOR
    // any other identifier for the original payment card — only
    // remaining_card_number/remaining_card_holder (both null in that sample),
    // which read like the *remaining-balance* payment card after a partial
    // payment, a different concept from "the card to pay the full invoice
    // to". Deliberately NOT folding remaining_card_* into cardNumber/
    // cardHolder here — that semantic hasn't been confirmed live (would need
    // a real change-card or overpayment case) and could show a buyer the
    // wrong card if the guess is wrong. card_number/card_name/card_holder are
    // kept as tolerant fallbacks in case TonPays does send them in a status
    // this test never reached.
    cardNumber: data.card_number ?? null,
    cardHolder: data.card_name ?? data.card_holder ?? null,
  }
}

/** Cancels a pending invoice. Swallows a 409 (already non-pending); throws any other error. */
export async function cancelInvoice(invoiceId: string): Promise<void> {
  try {
    // Confirmed live (Task 10): same WRONG_API_KEY_KIND 403 as checkInvoice
    // under /api/v1/ with a custom_tg-kind key; /api/custom/v1/ works.
    await tonpaysFetch<unknown>(`/api/custom/v1/invoices/${invoiceId}/cancel`, { method: 'POST' })
  } catch (err) {
    if (err instanceof TonPaysApiError && err.httpStatus === 409) return
    throw err
  }
}

export async function changeCard(invoiceId: string): Promise<{ cardNumber: string; cardHolder: string }> {
  const data = await tonpaysFetch<any>(`/api/custom/v1/invoices/${invoiceId}/change-card`, { method: 'POST' })
  return { cardNumber: data.card_number, cardHolder: data.card_name ?? data.card_holder }
}

/**
 * Submits the buyer's refund destination card.
 *
 * Moved to /api/custom/v1/ by analogy with checkInvoice/cancelInvoice (both
 * confirmed live to 403 WRONG_API_KEY_KIND under /api/v1/ with a custom_tg
 * key) — but this specific endpoint has NOT itself been exercised live: doing
 * so needs a real overpaid invoice to reach the refund-pending state, which
 * wasn't available in the Task 10 round-trip (a single small invoice,
 * created then cancelled, never over/under-paid). Re-verify against a live
 * overpayment before fully trusting this path.
 */
export async function submitRefundCard(invoiceId: string, cardNumber: string, cardHolder: string): Promise<void> {
  await tonpaysFetch<unknown>(`/api/custom/v1/invoices/${invoiceId}/refund`, {
    method: 'POST',
    body: { card_number: cardNumber, card_holder: cardHolder },
  })
}
