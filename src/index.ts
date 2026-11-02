import 'dotenv/config'
import { buildApp } from './server.js'
import { mountWebhook, initWebhook, initStandbyBot } from './bot.js'
import { isStandby } from './appMode.js'
import { runFakeLikerJob, setNextScheduledRunAt, fakeLikerRunFailed } from './jobs/fakeLiker.js'
import { getLastFakeLikerRunAt } from './jobs/fakeLikerConfig.js'
import { runPurchaseMessageJob } from './jobs/purchaseMessage.js'
import { runTonPaysSweepJob } from './jobs/tonpaysSweep.js'
import { runLikeRevealJob } from './jobs/likeReveal.js'
import { trackJob, startMetricsServer, initJobMetrics } from './metrics.js'
import { msUntilNextTehranHour } from './likes/revealPick.js'
import { cleanupInterruptedBroadcasts } from './messaging/broadcast.js'
import { startChatListener } from './realtime/listener.js'

const FAKE_LIKER_FIRST_RUN_DELAY_MS = 60_000
const FAKE_LIKER_INTERVAL_MS = 6 * 60 * 60 * 1000
const PURCHASE_MSG_FIRST_RUN_DELAY_MS = 90_000
// Backstop only — the primary nudge is a per-payment 5-min timer scheduled at
// checkout (see jobs/purchaseMessage.schedulePurchaseCheckoutFollowup). This
// sweep just mops up checks lost to a sleep/restart during the 5-min window.
const PURCHASE_MSG_INTERVAL_MS = 15 * 60 * 1000
const TONPAYS_SWEEP_FIRST_RUN_DELAY_MS = 120_000
const TONPAYS_SWEEP_INTERVAL_MS = 10 * 60 * 1000

// The bot's own public base URL — where Telegram POSTs webhook updates.
// Required in live mode.
function resolvePublicUrl(): string {
  const url = process.env.PUBLIC_URL
  if (!url) {
    throw new Error('PUBLIC_URL is required to register the Telegram webhook')
  }
  return url
}

const app = await buildApp()
// Real-time chat (GET /events) in every mode — standby still serves the API.
startChatListener(app.log)
// Any broadcast still 'running' was orphaned by a prior restart — mark it interrupted.
await cleanupInterruptedBroadcasts().catch((err) =>
  console.error('[broadcast] interrupted-cleanup failed:', (err as Error).message))

// Standby (a server that must not own the bot): API only — no webhook, no scheduled jobs.
// The live deployment keeps the bot until APP_MODE is switched to live.
const isLive = process.env.NODE_ENV === 'production' && !isStandby()

if (isLive) {
  // Route must be registered before app.listen(); initWebhook (below) runs after.
  mountWebhook(app)
  initJobMetrics(['fake_liker', 'purchase_message', 'tonpays_sweep', 'like_reveal'])

  const runFakeLikerSafely = async () => {
    try {
      await trackJob('fake_liker', async () => {
        const result = await runFakeLikerJob('schedule', app.log)
        // The job swallows its own errors; surface a whole-run failure to the metrics.
        if (fakeLikerRunFailed(result)) {
          throw new Error(`fake liker: run failed (errors=${'errors' in result ? result.errors : 0})`)
        }
        return result
      })
    } catch (err) {
      app.log.warn({ err }, 'fake liker: scheduled run failed')
    }
  }
  // Chained timeout (not setInterval) so the recorded next-run time always matches
  // the timer that will actually fire, even if a run takes long.
  const scheduleFakeLikerRun = (delayMs: number) => {
    setNextScheduledRunAt(new Date(Date.now() + delayMs).toISOString())
    setTimeout(async () => {
      await runFakeLikerSafely()
      scheduleFakeLikerRun(FAKE_LIKER_INTERVAL_MS)
    }, delayMs)
  }
  // Resume the cadence across restarts: schedule the first run at last_run + 6h
  // rather than shortly after every boot, so deploys don't re-trigger the job.
  // Overdue (or no prior run) → the short boot delay; otherwise wait the remainder.
  const lastRunAt = await getLastFakeLikerRunAt()
  const firstRunDelayMs = lastRunAt
    ? Math.max(
        FAKE_LIKER_INTERVAL_MS - (Date.now() - new Date(lastRunAt).getTime()),
        FAKE_LIKER_FIRST_RUN_DELAY_MS,
      )
    : FAKE_LIKER_FIRST_RUN_DELAY_MS
  scheduleFakeLikerRun(firstRunDelayMs)

  // Abandoned-checkout backstop: every 15 min, mop up any per-payment follow-up
  // checks that were lost to a restart/sleep. Idempotent via purchase_message_sends,
  // so re-firing shortly after a deploy is harmless — no last-run resume needed.
  const schedulePurchaseMessageRun = (delayMs: number) => {
    setTimeout(async () => {
      try {
        await trackJob('purchase_message', () => runPurchaseMessageJob({ log: app.log }))
      } catch (err) {
        app.log.warn({ err }, 'purchase-message: scheduled run failed')
      }
      schedulePurchaseMessageRun(PURCHASE_MSG_INTERVAL_MS)
    }, delayMs)
  }
  schedulePurchaseMessageRun(PURCHASE_MSG_FIRST_RUN_DELAY_MS)

  // TonPays pending-invoice sweep: catches payment confirmations lost to a
  // missed/failed webhook delivery, and cleans up long-abandoned invoices.
  // No-ops internally when TonPays isn't configured, so this is safe to
  // always schedule.
  const scheduleTonPaysSweepRun = (delayMs: number) => {
    setTimeout(async () => {
      try {
        await trackJob('tonpays_sweep', () => runTonPaysSweepJob({ log: app.log }))
      } catch (err) {
        app.log.warn({ err }, 'tonpays sweep: scheduled run failed')
      }
      scheduleTonPaysSweepRun(TONPAYS_SWEEP_INTERVAL_MS)
    }, delayMs)
  }
  scheduleTonPaysSweepRun(TONPAYS_SWEEP_FIRST_RUN_DELAY_MS)

  // Re-anchor to 18:00 Tehran after every run (a flat 24h from completion would
  // drift later each day by however long the job took).
  const scheduleLikeReveal = (delayMs: number) => {
    setTimeout(async () => {
      try {
        await trackJob('like_reveal', () => runLikeRevealJob())
      } catch (err) {
        app.log.warn({ err }, 'like-reveal: scheduled run failed')
      }
      scheduleLikeReveal(msUntilNextTehranHour(18, new Date()))
    }, delayMs)
  }
  scheduleLikeReveal(msUntilNextTehranHour(18, new Date()))
} else if (process.env.NODE_ENV === 'production') {
  console.log('[standby] APP_MODE=standby: webhook and scheduled jobs disabled')
} else {
  // Skip bot in dev — fake BOT_TOKEN would crash the process
  console.log('[dev] Bot disabled (set NODE_ENV=production and a real BOT_TOKEN to enable)')
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
if (process.env.METRICS_PORT) startMetricsServer(Number(process.env.METRICS_PORT), app.log)

if (isLive) {
  try {
    await initWebhook(resolvePublicUrl())
  } catch (err) {
    // A live server with an unregistered webhook is a silently-dead bot (health
    // check stays green), so crash to force the platform to restart and retry.
    console.error('[bot] webhook registration failed:', (err as Error).message)
    process.exit(1)
  }
} else if (process.env.NODE_ENV === 'production') {
  // Username only (used in API responses). Non-fatal: standby serves no bot traffic.
  await initStandbyBot().catch((err) =>
    console.error('[bot] standby init failed:', (err as Error).message))
}
