import 'dotenv/config'
import { buildApp } from './server.js'
import { mountWebhook, initWebhook } from './bot.js'
import { runFakeLikerJob, setNextScheduledRunAt } from './jobs/fakeLiker.js'
import { getLastFakeLikerRunAt } from './jobs/fakeLikerConfig.js'

const FAKE_LIKER_FIRST_RUN_DELAY_MS = 60_000
const FAKE_LIKER_INTERVAL_MS = 6 * 60 * 60 * 1000

// The bot's own public base URL — where Telegram POSTs webhook updates.
// PUBLIC_URL wins; otherwise fall back to the host platform's injected value.
function resolvePublicUrl(): string {
  const url =
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined)
  if (!url) {
    throw new Error(
      'PUBLIC_URL (or RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN) is required to register the Telegram webhook',
    )
  }
  return url
}

const app = await buildApp()
if (process.env.NODE_ENV === 'production') {
  // Route must be registered before app.listen(); initWebhook (below) runs after.
  mountWebhook(app)

  const runFakeLikerSafely = async () => {
    try {
      await runFakeLikerJob('schedule', app.log)
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
} else {
  // Skip bot in dev — fake BOT_TOKEN would crash the process
  console.log('[dev] Bot disabled (set NODE_ENV=production and a real BOT_TOKEN to enable)')
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })

if (process.env.NODE_ENV === 'production') {
  try {
    await initWebhook(resolvePublicUrl())
  } catch (err) {
    // A live server with an unregistered webhook is a silently-dead bot (health
    // check stays green), so crash to force the platform to restart and retry.
    console.error('[bot] webhook registration failed:', (err as Error).message)
    process.exit(1)
  }
}
