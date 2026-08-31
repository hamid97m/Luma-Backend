import type { BroadcastTarget } from './audience.js'

export interface RunBroadcastOptions {
  /** Deliver one message; should throw on Telegram errors (403/429/etc). */
  send: (telegramId: number, text: string) => Promise<void>
  /** Called with the user id when a send fails with 403 (bot blocked). */
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
function isBlocked(err: any): boolean {
  return errorCode(err) === 403
}
function retryAfterMs(err: any): number | undefined {
  const ra = err?.parameters?.retry_after
  return typeof ra === 'number' ? ra * 1000 : undefined
}

/**
 * Send `message` to every target, throttled in batches. Never throws for a
 * single failed recipient — counts it and moves on. Returns final tallies.
 */
export async function runBroadcast(
  message: string,
  targets: BroadcastTarget[],
  opts: RunBroadcastOptions,
): Promise<{ sent: number; failed: number }> {
  const sleep = opts.sleep ?? defaultSleep
  const batchSize = opts.batchSize ?? 25
  const pauseMs = opts.pauseMs ?? 1000
  let sent = 0
  let failed = 0

  const deliver = async (target: BroadcastTarget): Promise<void> => {
    try {
      await opts.send(target.telegram_id, message)
      sent++
    } catch (err) {
      // Honor a single 429 backoff-and-retry before giving up on this recipient.
      const backoff = retryAfterMs(err)
      if (backoff != null) {
        await sleep(backoff)
        try {
          await opts.send(target.telegram_id, message)
          sent++
          return
        } catch (err2) {
          err = err2
        }
      }
      failed++
      if (isBlocked(err)) {
        try { await opts.onOptOut(target.id) } catch { /* best-effort */ }
      }
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
export async function cleanupInterruptedBroadcasts(dbClient: any, nowIso = new Date().toISOString()): Promise<void> {
  await dbClient
    .from('broadcasts')
    .update({ status: 'interrupted', finished_at: nowIso })
    .eq('status', 'running')
}
