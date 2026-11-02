// Pending-invoice sweep: TonPays card-to-card payments are confirmed by a
// webhook (see payments/tonpaysWebhook or similar), but a webhook can be
// lost (network blip, restart mid-delivery). This sweep polls TonPays
// directly for any `premium_transactions` row still `pending_payment` so a
// lost webhook doesn't leave a paying user ungranted, and so long-abandoned
// rows eventually get cleaned up instead of lingering forever.
import { sql } from '../db.js'
import { isTonPaysConfigured, checkInvoice, cancelInvoice } from '../payments/tonpays.js'
import { handleTonPaysPaid } from '../premium/service.js'
import type { FastifyBaseLogger } from 'fastify'

// A row becomes checkable once it's had time to actually complete a transfer
// (card-to-card isn't instant) — polling anything younger just wastes upstream
// calls on invoices that are still legitimately in flight.
const MIN_AGE_MS = 10 * 60 * 1000
// Past this age an abandoned invoice is treated as dead: cancel it upstream
// (best-effort) and locally. The upstream cancel matters because TonPays'
// invoice TTL is undocumented and was never observed to expire — and TonPays
// allows only ONE pending invoice per buyer, so an invoice we stop tracking
// while it is still live upstream would block that buyer from ever checking
// out again (recoverUntrackedPendingInvoice in premium/service.ts is the other
// half of that safety net).
const ANCIENT_AGE_MS = 48 * 60 * 60 * 1000
// Sequential checks (one upstream call at a time, rate-cap friendliness) cap
// the run's own duration and the load this job puts on TonPays.
const CHECK_CAP = 30
// Cleaning up ancient rows needs no upstream call, so it can afford to clear a
// bigger backlog per run; still bounded so one run can't scan unboundedly.
const ANCIENT_CAP = 200

interface PendingRow {
  id: string
  tonpays_invoice_id: string | null
}

/**
 * Sweeps pending TonPays `premium_transactions` rows:
 *  - rows older than 48h are canceled outright, no upstream call (long dead)
 *  - rows between 10m and 48h old (max 30/run) are checked against TonPays,
 *    sequentially: `paid` grants via `handleTonPaysPaid`; `expired`/`canceled`
 *    marks the row `canceled` (recording the upstream `tonpays_status`);
 *    anything else (still pending) is left alone for the next run.
 * A row with no `tonpays_invoice_id` means create-invoice failed mid-checkout
 * before the row could be marked canceled — it can't be checked upstream
 * (there's nothing to check), so it is skipped unless it's also ancient, in
 * which case it gets swept up in the no-upstream-call cleanup above.
 * A single row's check failure is logged and does not abort the run.
 */
export async function runTonPaysSweepJob({ log }: { log: FastifyBaseLogger }): Promise<void> {
  if (!isTonPaysConfigured()) return

  const now = Date.now()
  const youngCutoff = new Date(now - MIN_AGE_MS).toISOString()
  const ancientCutoff = new Date(now - ANCIENT_AGE_MS).toISOString()

  await cancelAncientRows(ancientCutoff, log)
  await checkPendingRows(youngCutoff, ancientCutoff, log)
}

/** Rows past the ancient cutoff are dead: cancel each one upstream (best-effort,
 * sequentially, one row's failure never stopping the rest) so no live invoice is
 * left blocking that buyer, then cancel them locally in one batch. */
async function cancelAncientRows(ancientCutoff: string, log: FastifyBaseLogger): Promise<void> {
  let rows: PendingRow[]
  try {
    rows = await sql<PendingRow[]>`
      select id, tonpays_invoice_id from premium_transactions
      where provider = 'tonpays' and status = 'pending_payment'
        and created_at <= ${ancientCutoff}
      limit ${ANCIENT_CAP}`
  } catch (err) { log.warn({ err }, 'tonpays sweep: ancient-row query failed'); return }
  if (rows.length === 0) return

  // Cancel upstream first, one row at a time (rate-cap friendliness), and keep
  // going on failure — the local cancel below must happen either way, or the
  // row would be re-swept forever.
  for (const row of rows) {
    if (!row.tonpays_invoice_id) continue // never got an invoice; nothing upstream to cancel
    try {
      await cancelInvoice(row.tonpays_invoice_id)
    } catch (err) {
      log.warn({ err, txId: row.id }, 'tonpays sweep: upstream cancel of ancient invoice failed')
    }
  }

  const ids = rows.map((r) => r.id)
  // Guard on status='pending_payment': between the SELECT above and this
  // UPDATE, a webhook (or this same job's own checkable-window pass, if a row
  // somehow qualified for both) could have already paid/graded the row —
  // without the guard this would silently clobber a paid row back to
  // canceled. Same idempotency pattern as handleTonPaysPaid.
  try {
    await sql`
      update premium_transactions set status = 'canceled'
      where status = 'pending_payment' and id = any(${ids}::uuid[])`
  } catch (err) { log.warn({ err }, 'tonpays sweep: ancient-row cancel failed') }
}

/** Rows in the checkable window get polled against TonPays, one at a time. */
async function checkPendingRows(youngCutoff: string, ancientCutoff: string, log: FastifyBaseLogger): Promise<void> {
  let rows: PendingRow[]
  try {
    rows = await sql<PendingRow[]>`
      select id, tonpays_invoice_id from premium_transactions
      where provider = 'tonpays' and status = 'pending_payment'
        and created_at < ${youngCutoff} and created_at > ${ancientCutoff}
      order by created_at asc
      limit ${CHECK_CAP}`
  } catch (err) { log.warn({ err }, 'tonpays sweep: pending-row query failed'); return }
  for (const row of rows) {
    if (!row.tonpays_invoice_id) continue // create-invoice never completed; nothing to check yet
    try {
      await checkOneRow(row, log)
    } catch (err) {
      log.warn({ err, txId: row.id }, 'tonpays sweep: invoice check failed')
    }
  }
}

async function checkOneRow(row: PendingRow, log: FastifyBaseLogger): Promise<void> {
  const invoiceId = row.tonpays_invoice_id as string
  const result = await checkInvoice(invoiceId)

  if (result.paid) {
    const outcome = await handleTonPaysPaid(invoiceId)
    if (outcome === 'grant_failed') log.warn({ invoiceId, txId: row.id }, 'tonpays sweep: grant failed')
    // 'not_found' means TonPays reports this invoice paid but we have no
    // matching transaction row at all (not even a non-pending one) — a data
    // drift signal worth flagging, distinct from the normal 'already' replay.
    if (outcome === 'not_found') log.warn({ invoiceId, txId: row.id }, 'tonpays sweep: paid invoice not found in premium_transactions')
    return
  }

  if (result.status === 'expired' || result.status === 'canceled') {
    // Guard on status='pending_payment' — the row could have been paid
    // (webhook or an earlier pass) between the SELECT and this UPDATE;
    // without the guard this would silently clobber a paid row back to
    // canceled. Same idempotency pattern as handleTonPaysPaid.
    try {
      await sql`
        update premium_transactions set status = 'canceled', tonpays_status = ${result.status}
        where id = ${row.id} and status = 'pending_payment'`
    } catch (err) { log.warn({ err, txId: row.id }, 'tonpays sweep: cancel update failed') }
  }
  // Any other status (still pending) is left alone for the next run.
}
