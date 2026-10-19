// Pending-invoice sweep: TonPays card-to-card payments are confirmed by a
// webhook (see payments/tonpaysWebhook or similar), but a webhook can be
// lost (network blip, restart mid-delivery). This sweep polls TonPays
// directly for any `premium_transactions` row still `pending_payment` so a
// lost webhook doesn't leave a paying user ungranted, and so long-abandoned
// rows eventually get cleaned up instead of lingering forever.
import { db } from '../db.js'
import { isTonPaysConfigured, checkInvoice } from '../payments/tonpays.js'
import { handleTonPaysPaid } from '../premium/service.js'
import type { FastifyBaseLogger } from 'fastify'

const TABLE = 'premium_transactions'

// A row becomes checkable once it's had time to actually complete a transfer
// (card-to-card isn't instant) — polling anything younger just wastes upstream
// calls on invoices that are still legitimately in flight.
const MIN_AGE_MS = 10 * 60 * 1000
// Past this age an abandoned invoice is treated as dead: cancel it locally
// without another upstream call (TonPays invoices expire well before this).
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

/** Rows past the ancient cutoff are dead; cancel them in one batch, no upstream call. */
async function cancelAncientRows(ancientCutoff: string, log: FastifyBaseLogger): Promise<void> {
  const { data, error } = await db
    .from(TABLE)
    .select('id, tonpays_invoice_id')
    .eq('provider', 'tonpays')
    .eq('status', 'pending_payment')
    .lte('created_at', ancientCutoff)
    .limit(ANCIENT_CAP)
  if (error) { log.warn({ err: error }, 'tonpays sweep: ancient-row query failed'); return }

  const rows = (data ?? []) as PendingRow[]
  if (rows.length === 0) return

  const ids = rows.map((r) => r.id)
  // Guard on status='pending_payment': between the SELECT above and this
  // UPDATE, a webhook (or this same job's own checkable-window pass, if a row
  // somehow qualified for both) could have already paid/graded the row —
  // without the guard this would silently clobber a paid row back to
  // canceled. Same idempotency pattern as handleTonPaysPaid.
  const { error: updErr } = await db
    .from(TABLE)
    .update({ status: 'canceled' })
    .eq('status', 'pending_payment')
    .in('id', ids)
  if (updErr) log.warn({ err: updErr }, 'tonpays sweep: ancient-row cancel failed')
}

/** Rows in the checkable window get polled against TonPays, one at a time. */
async function checkPendingRows(youngCutoff: string, ancientCutoff: string, log: FastifyBaseLogger): Promise<void> {
  const { data, error } = await db
    .from(TABLE)
    .select('id, tonpays_invoice_id')
    .eq('provider', 'tonpays')
    .eq('status', 'pending_payment')
    .lt('created_at', youngCutoff)
    .gt('created_at', ancientCutoff)
    .order('created_at', { ascending: true })
    .limit(CHECK_CAP)
  if (error) { log.warn({ err: error }, 'tonpays sweep: pending-row query failed'); return }

  const rows = (data ?? []) as PendingRow[]
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
    const { error } = await db
      .from(TABLE)
      .update({ status: 'canceled', tonpays_status: result.status })
      .eq('id', row.id)
      .eq('status', 'pending_payment')
    if (error) log.warn({ err: error, txId: row.id }, 'tonpays sweep: cancel update failed')
  }
  // Any other status (still pending) is left alone for the next run.
}
