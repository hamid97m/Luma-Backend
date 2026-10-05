import 'dotenv/config'
import { db } from '../src/db.js'
import { updateUserGeo } from '../src/geo/resolveCity.js'

// Resolves the hidden geo_city/geo_country for every user that has a typed
// location but no geo yet. Safe to re-run: spellings are cached in
// city_lookups, so only new spellings hit DeepSeek.
//   pnpm -C backend backfill:geo

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set')
  process.exit(1)
}

// PostgREST caps each response (1000 rows on Supabase), so collect the full
// list page by page before any row is updated.
const PAGE = 1000
const CONCURRENCY = 5

const todo: Array<{ id: string; location: string }> = []
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('users')
    .select('id, location')
    .not('location', 'is', null)
    .neq('location', '')
    .is('geo_country', null)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) {
    console.error('query failed:', error.message)
    process.exit(1)
  }
  todo.push(...(data ?? []))
  if (!data || data.length < PAGE) break
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
