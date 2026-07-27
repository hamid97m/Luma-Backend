import { buildApp } from './server.js'
import { startBot } from './bot.js'

const app = await buildApp()
startBot()
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
