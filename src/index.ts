import 'dotenv/config'
import { buildApp } from './server.js'
import { startBot } from './bot.js'
import { runFakeLikerJob, setNextScheduledRunAt } from './jobs/fakeLiker.js'
import { getLastFakeLikerRunAt } from './jobs/fakeLikerConfig.js'

const FAKE_LIKER_FIRST_RUN_DELAY_MS = 60_000
const FAKE_LIKER_INTERVAL_MS = 6 * 60 * 60 * 1000

const app = await buildApp()
if (process.env.NODE_ENV === 'production') {
  startBot()

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
