import 'dotenv/config'
import { sql } from '../src/db.js'
import { updateUserGeo } from '../src/geo/resolveCity.js'

// Resolves the hidden geo_city/geo_country for every user that has a typed
// location but no geo yet. Safe to re-run: spellings are cached in
// city_lookups, so only new spellings hit DeepSeek.
//   pnpm -C backend backfill:geo

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set')
  process.exit(1)
}
// One-off catch-up gets a bigger ceiling than the live server (~$0.50 max).
process.env.DEEPSEEK_DAILY_LIMIT ??= '5000'

const CONCURRENCY = 5

// Collect the full list before any row is updated.
let todo: Array<{ id: string; location: string }>
try {
  todo = await sql<Array<{ id: string; location: string }>>`
    select id, location from users
    where location is not null and location <> ''
      and geo_country is null and deleted_at is null
    order by id asc`
} catch (err) {
  console.error('query failed:', (err as Error).message)
  await sql.end()
  process.exit(1)
}
console.log(`${todo.length} users to resolve`)

let resolved = 0
let unrecognized = 0
let failed = 0
let next = 0

async function worker() {
  while (next < todo.length) {
    const u = todo[next++]
    try {
      const geo = await updateUserGeo(u.id, u.location)
      if (geo.country) resolved++
      else unrecognized++
    } catch (err) {
      failed++
      console.warn(`user ${u.id} ("${u.location}") failed:`, (err as Error).message)
    }
    const done = resolved + unrecognized + failed
    if (done % 100 === 0) console.log(`${done}/${todo.length}`)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log(`done: ${resolved} resolved, ${unrecognized} unrecognized, ${failed} failed`)
await sql.end()
