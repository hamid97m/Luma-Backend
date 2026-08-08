import 'dotenv/config'
import { buildApp } from './server.js'
import { startBot } from './bot.js'
import { runFakeLikerJob, setNextScheduledRunAt } from './jobs/fakeLiker.js'

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
  scheduleFakeLikerRun(FAKE_LIKER_FIRST_RUN_DELAY_MS)
} else {
  // Skip bot in dev — fake BOT_TOKEN would crash the process
  console.log('[dev] Bot disabled (set NODE_ENV=production and a real BOT_TOKEN to enable)')
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
