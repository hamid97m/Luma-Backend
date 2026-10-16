import 'dotenv/config'
import { db } from '../src/db.js'

// Photos uploaded by the Mini App / admin panel before the Cache-Control fix
// were stored as `no-cache`, so every view revalidates against the storage
// origin. This re-uploads each such object in place (same path, so stored
// URLs stay valid) with a 7-day max-age. Dry run by default:
//   pnpm -C backend fix:photo-cache            # report only
//   pnpm -C backend fix:photo-cache --apply    # rewrite

const BUCKET = 'profile-photos'
const CACHE_SECONDS = '604800'
const PAGE = 1000
const CONCURRENCY = 5
const apply = process.argv.includes('--apply')
const marker = `/object/public/${BUCKET}/`

const paths = new Set<string>()
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('user_photos')
    .select('url')
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) {
    console.error('query failed:', error.message)
    process.exit(1)
  }
  for (const { url } of data ?? []) {
    const i = typeof url === 'string' ? url.indexOf(marker) : -1
    if (i !== -1) paths.add(decodeURIComponent(url.slice(i + marker.length).split('?')[0]))
  }
  if (!data || data.length < PAGE) break
}
console.log(`${paths.size} photo objects referenced`)

const todo = [...paths]
const byCacheControl = new Map<string, number>()
let fixed = 0
let missing = 0
let failed = 0
let next = 0

async function worker() {
  while (next < todo.length) {
    const path = todo[next++]
    try {
      const { data: info, error: infoErr } = await db.storage.from(BUCKET).info(path)
      if (infoErr || !info) {
        missing++
        continue
      }
      const cc = info.cacheControl ?? '(none)'
      byCacheControl.set(cc, (byCacheControl.get(cc) ?? 0) + 1)
      if (!apply || /max-age=[1-9]/.test(cc)) continue

      const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(path)
      if (dlErr || !blob) throw dlErr ?? new Error('download_failed')
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, blob, {
        upsert: true,
        cacheControl: CACHE_SECONDS,
        contentType: info.contentType ?? 'image/jpeg',
      })
      if (upErr) throw upErr
      fixed++
    } catch (err) {
      failed++
      console.warn(`${path} failed:`, (err as Error).message)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log('Cache-Control before:', Object.fromEntries(byCacheControl))
console.log(apply
  ? `done: ${fixed} rewritten, ${missing} missing, ${failed} failed`
  : `dry run: ${missing} missing — re-run with --apply to rewrite no-cache objects`)
