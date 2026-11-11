import 'dotenv/config'
import { Api } from 'grammy'
import { sql } from '../src/db.js'
import { botStatusTracker, recordBotStatus } from '../src/botStatus.js'

// One-off: learn users.bot_status for users we know nothing about yet by sending a
// "typing…" chat action (no message). Delivered → active; 403 → blocked / deactivated /
// not_started (recorded by botStatusTracker). Pass --all to re-check everyone.
// Usage on the server: pnpm exec tsx scripts/backfill-bot-status.ts [--all]

const all = process.argv.includes('--all')
const api = new Api(process.env.BOT_TOKEN!)
api.config.use(botStatusTracker)

const users = await sql<{ telegram_id: number }[]>`
  select telegram_id::float8 as telegram_id from users
  where telegram_id > 0 and not is_seed ${all ? sql`` : sql`and bot_status is null`}
  order by last_active desc nulls last`
console.log(`checking ${users.length} users`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tally: Record<string, number> = {}
for (const [i, { telegram_id }] of users.entries()) {
  for (;;) {
    try {
      await api.sendChatAction(telegram_id, 'typing')
      tally.active = (tally.active ?? 0) + 1
      break
    } catch (err: any) {
      const retry = err?.parameters?.retry_after
      if (err?.error_code === 429 && retry) { await sleep((retry + 1) * 1000); continue }
      const d = String(err?.description ?? err?.message ?? err)
      tally[d] = (tally[d] ?? 0) + 1
      // "chat not found" = Telegram never saw a chat with this user → treat as never started.
      if (/chat not found/i.test(d)) await recordBotStatus(telegram_id, 'not_started')
      break
    }
  }
  if ((i + 1) % 200 === 0) console.log(`${i + 1}/${users.length}`, tally)
  await sleep(50) // ~20/s, under the bot-wide limit
}
await sleep(500) // let fire-and-forget status writes land
console.log('done', tally)
await sql.end()
