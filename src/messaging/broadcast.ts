import { sql } from '../db.js'
import type { BroadcastTarget, PushTarget } from './audience.js'
import { sendPushToTokens, type PushPayload } from '../push/fcm.js'

export type SendOutcome = 'ok' | 'optout' | 'fail'

export interface RunBroadcastOptions<T extends { id: string }> {
  /** Deliver to one recipient. Must not throw for ordinary failures: return
   * 'fail', or 'optout' when the recipient blocked the bot (403). */
  send: (target: T) => Promise<SendOutcome>
  /** Called with the user id when send returns 'optout'. */
  onOptOut: (userId: string) => Promise<void>
  /** Called after each batch with running totals so the caller can persist them. */
  onProgress: (counts: { sent: number; failed: number }) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  batchSize?: number
  pauseMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function errorCode(err: any): number | undefined {
  return typeof err?.error_code === 'number' ? err.error_code : undefined
}
function retryAfterMs(err: any): number | undefined {
  const ra = err?.parameters?.retry_after
  return typeof ra === 'number' ? ra * 1000 : undefined
}

/** Telegram send adapter: honors a single 429 backoff-and-retry, maps 403 to 'optout'.
 * `deliver` should throw on Telegram errors. */
export function botSendAdapter(
  deliver: (telegramId: number) => Promise<void>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): (t: BroadcastTarget) => Promise<SendOutcome> {
  return async (target) => {
    try {
      await deliver(target.telegram_id)
      return 'ok'
    } catch (err: any) {
      const backoff = retryAfterMs(err)
      if (backoff != null) {
        await sleep(backoff)
        try {
          await deliver(target.telegram_id)
          return 'ok'
        } catch (err2) {
          err = err2
        }
      }
      return errorCode(err) === 403 ? 'optout' : 'fail'
    }
  }
}

/** Push send adapter: 'ok' when at least one token succeeded. Dead tokens are
 * pruned inside sendPushToTokens; a rejection (e.g. DB error) counts as 'fail'. */
export function pushSendAdapter(payload: PushPayload): (t: PushTarget) => Promise<SendOutcome> {
  return async (target) => {
    try {
      const res = await sendPushToTokens(target.tokens, payload)
      return res.ok.length > 0 ? 'ok' : 'fail'
    } catch {
      return 'fail'
    }
  }
}

/**
 * Deliver to every target, throttled in batches. Never throws for a single
 * failed recipient — counts it and moves on. Returns final tallies.
 */
export async function runBroadcast<T extends { id: string }>(
  targets: T[],
  opts: RunBroadcastOptions<T>,
): Promise<{ sent: number; failed: number }> {
  const sleep = opts.sleep ?? defaultSleep
  const batchSize = opts.batchSize ?? 25
  const pauseMs = opts.pauseMs ?? 1000
  let sent = 0
  let failed = 0

  const deliver = async (target: T): Promise<void> => {
    let outcome: SendOutcome
    try {
      outcome = await opts.send(target)
    } catch {
      outcome = 'fail'
    }
    if (outcome === 'ok') { sent++; return }
    failed++
    if (outcome === 'optout') {
      try { await opts.onOptOut(target.id) } catch { /* best-effort */ }
    }
  }

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    await Promise.all(batch.map(deliver))
    await opts.onProgress({ sent, failed })
    if (i + batchSize < targets.length) await sleep(pauseMs)
  }

  return { sent, failed }
}

/** Mark broadcasts left 'running' by a prior process restart as 'interrupted'. */
export async function cleanupInterruptedBroadcasts(nowIso = new Date().toISOString()): Promise<void> {
  await sql`update broadcasts set status = 'interrupted', finished_at = ${nowIso} where status = 'running'`
}
