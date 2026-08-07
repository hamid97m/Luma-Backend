import 'dotenv/config'
import { buildApp } from './server.js'
import { startBot } from './bot.js'
import { runFakeLikerJob } from './jobs/fakeLiker.js'

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
  setTimeout(() => { void runFakeLikerSafely() }, FAKE_LIKER_FIRST_RUN_DELAY_MS)
  setInterval(() => { void runFakeLikerSafely() }, FAKE_LIKER_INTERVAL_MS)
} else {
  // Skip bot in dev — fake BOT_TOKEN would crash the process
  console.log('[dev] Bot disabled (set NODE_ENV=production and a real BOT_TOKEN to enable)')
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
