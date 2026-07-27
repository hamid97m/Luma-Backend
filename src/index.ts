import 'dotenv/config'
import { buildApp } from './server.js'
import { startBot } from './bot.js'

const app = await buildApp()
if (process.env.NODE_ENV === 'production') {
  startBot()
} else {
  // Skip bot in dev — fake BOT_TOKEN would crash the process
  console.log('[dev] Bot disabled (set NODE_ENV=production and a real BOT_TOKEN to enable)')
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
