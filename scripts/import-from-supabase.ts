import postgres from 'postgres'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { isSafeObjectPath } from '../src/storage.js'

/**
 * One-shot data move Supabase → self-hosted server (Postgres 16 + files on disk).
 * Runs ON THE NEW SERVER: once as a rehearsal, once at cutover (old backend stopped).
 * Runbook: docs/deploy/parspack-server-setup.md → "Data import".
 *
 *   tsx scripts/import-from-supabase.ts [--data] [--files] [--rewrite-urls] [--verify] [--all] [--yes]
 *
 * Steps (in this order; --all = all four):
 *   --data          wipe target public tables (except schema_migrations) and stream every table
 *                   from the source with COPY, in ONE target transaction with
 *                   session_replication_role=replica (no FK checks, no triggers → self-referencing
 *                   FKs load in any order and the messages trigger doesn't touch matches).
 *                   The source is read in one REPEATABLE READ READ ONLY transaction (consistent snapshot).
 *   --files         download every object of the storage buckets into MEDIA_DIR (same layout as
 *                   src/storage.ts). Incremental: a file already on disk with the same size is skipped.
 *   --rewrite-urls  replace `${SUPABASE_URL}/storage/v1/object/public/` with `${MEDIA_PUBLIC_URL}/`
 *                   in every text / varchar / text[] / json / jsonb column of the target.
 *   --verify        row counts source vs target, storage objects vs files on disk, sample photo URLs.
 * Without --yes nothing on the target (DB or disk) is changed: it prints what it would do.
 *
 * Env:
 *   SOURCE_DATABASE_URL   Supabase Postgres (direct or session pooler :5432). Only ever read:
 *                         the session starts with default_transaction_read_only=on and every
 *                         read runs in a READ ONLY transaction.
 *                         (SOURCE_NO_STARTUP_OPTIONS=1 drops the startup option if a pooler rejects
 *                         it; the READ ONLY transactions still apply.)
 *   TARGET_DATABASE_URL   local Postgres as a SUPERUSER (session_replication_role needs it), e.g.
 *                         postgres:///luma?host=/var/run/postgresql  (run as OS user postgres)
 *   SUPABASE_URL          https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service-role key (downloads from the private bucket)
 *   MEDIA_DIR             default /var/lib/luma/media
 *   MEDIA_PUBLIC_URL      e.g. https://api.example.com/media
 */

// ── Types / config ───────────────────────────────────────────────────────

type Sql = postgres.Sql<{}>

export const BUCKETS = [
  { id: 'profile-photos', public: true },
  { id: 'photo-ai-evidence', public: false },
] as const

const SKIP_TABLES = new Set(['schema_migrations'])
const DOWNLOAD_CONCURRENCY = 8
const DOWNLOAD_ATTEMPTS = 3

export interface ImportConfig {
  sourceUrl?: string
  targetUrl?: string
  supabaseUrl?: string
  serviceKey?: string
  mediaDir: string
  mediaPublicUrl?: string
  /** Pass false when the source sits behind a pooler that rejects startup options. */
  sourceStartupReadOnly?: boolean
  log?: (line: string) => void
  /** Test hook: override fetch. */
  fetchImpl?: typeof fetch
}

export interface Ctx {
  cfg: ImportConfig
  yes: boolean
  log: (line: string) => void
  source: () => Sql
  target: () => Sql
}

export class ImportError extends Error {}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') throw new ImportError(`${name} is not set`)
  return value
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

function oldPublicPrefix(cfg: ImportConfig): string {
  return `${trimSlash(need(cfg.supabaseUrl, 'SUPABASE_URL'))}/storage/v1/object/public/`
}
function newPublicPrefix(cfg: ImportConfig): string {
  return `${trimSlash(need(cfg.mediaPublicUrl, 'MEDIA_PUBLIC_URL'))}/`
}

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function table(rows: (string | number)[][], log: (l: string) => void): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)))
  for (const r of rows) {
    log('  ' + r.map((c, i) => (typeof c === 'number' ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  '))
  }
}

// ── Connections ──────────────────────────────────────────────────────────

const SESSION = { TimeZone: 'UTC', DateStyle: 'ISO, MDY', IntervalStyle: 'postgres', extra_float_digits: '3' }

export function openSource(cfg: ImportConfig): Sql {
  const connection: Record<string, string> = { ...SESSION, application_name: 'luma-import (read-only)' }
  if (cfg.sourceStartupReadOnly !== false) connection.default_transaction_read_only = 'on'
  return postgres(need(cfg.sourceUrl, 'SOURCE_DATABASE_URL'), {
    max: 2, onnotice: () => {}, connection, prepare: false, idle_timeout: 20,
  })
}

export function openTarget(cfg: ImportConfig): Sql {
  const url = need(cfg.targetUrl, 'TARGET_DATABASE_URL')
  if (/supabase\.(co|com)/i.test(url)) throw new ImportError('TARGET_DATABASE_URL points at Supabase — refusing')
  if (cfg.sourceUrl && url === cfg.sourceUrl) throw new ImportError('TARGET_DATABASE_URL equals SOURCE_DATABASE_URL — refusing')
  return postgres(url, { max: 2, onnotice: () => {}, connection: { ...SESSION, application_name: 'luma-import' }, idle_timeout: 20 })
}

/** Every source read goes through this: one consistent, read-only snapshot. */
function readSource<T>(ctx: Ctx, fn: (tx: postgres.TransactionSql<{}>) => Promise<T>): Promise<T> {
  return ctx.source().begin('isolation level repeatable read read only', fn) as Promise<T>
}

// ── Schema introspection ─────────────────────────────────────────────────

interface Col { name: string; udt: string }

async function publicTables(sql: Sql | postgres.TransactionSql<{}>): Promise<Map<string, Col[]>> {
  const rows = await sql<{ table_name: string; column_name: string; udt_name: string }[]>`
    select c.table_name, c.column_name, c.udt_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.is_generated = 'NEVER'
    order by c.table_name, c.ordinal_position`
  const out = new Map<string, Col[]>()
  for (const r of rows) {
    if (SKIP_TABLES.has(r.table_name)) continue
    if (!out.has(r.table_name)) out.set(r.table_name, [])
    out.get(r.table_name)!.push({ name: r.column_name, udt: r.udt_name })
  }
  return out
}

/** Target tables + column lists, after checking the source has exactly the same shape. */
function compareSchemas(src: Map<string, Col[]>, tgt: Map<string, Col[]>): { problems: string[]; tables: [string, Col[]][] } {
  const problems: string[] = []
  for (const t of src.keys()) if (!tgt.has(t)) problems.push(`table ${t}: exists in source, missing in target`)
  for (const t of tgt.keys()) if (!src.has(t)) problems.push(`table ${t}: exists in target, missing in source`)
  for (const [t, tcols] of tgt) {
    const scols = src.get(t)
    if (!scols) continue
    const smap = new Map(scols.map((c) => [c.name, c.udt]))
    const tmap = new Map(tcols.map((c) => [c.name, c.udt]))
    for (const c of tcols) {
      if (!smap.has(c.name)) problems.push(`${t}.${c.name}: missing in source`)
      else if (smap.get(c.name) !== c.udt) problems.push(`${t}.${c.name}: type ${smap.get(c.name)} (source) ≠ ${c.udt} (target)`)
    }
    for (const c of scols) if (!tmap.has(c.name)) problems.push(`${t}.${c.name}: missing in target (its data would be lost)`)
  }
  return { problems, tables: [...tgt.entries()].sort(([a], [b]) => a.localeCompare(b)) }
}

async function countRows(sql: Sql | postgres.TransactionSql<{}>, tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const t of tables) {
    const [{ n }] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${qi(t)}`)
    out.set(t, n)
  }
  return out
}

// ── Step 1: data ─────────────────────────────────────────────────────────

export async function stepData(ctx: Ctx): Promise<{ counts: Map<string, number> }> {
  const { log } = ctx
  const target = ctx.target()

  return readSource(ctx, async (src) => {
    const { problems, tables } = compareSchemas(await publicTables(src), await publicTables(target))
    if (problems.length) {
      throw new ImportError(`source and target schemas differ:\n  - ${problems.join('\n  - ')}`)
    }
    const names = tables.map(([t]) => t)
    const srcCounts = await countRows(src, names)

    if (!ctx.yes) {
      const tgtCounts = await countRows(target, names)
      log(`DRY RUN — would TRUNCATE these ${names.length} target tables and copy from source:`)
      table([['table', 'source rows', 'target rows now'], ...names.map((t) => [t, srcCounts.get(t)!, tgtCounts.get(t)!])], log)
      return { counts: srcCounts }
    }

    const copied = new Map<string, number>()
    await target.begin(async (tx) => {
      await tx.unsafe(`truncate ${names.map((t) => `public.${qi(t)}`).join(', ')} restart identity cascade`)
      // Superuser only: skips FK checks and (non-ALWAYS) triggers for this transaction.
      await tx`set local session_replication_role = replica`

      for (const [t, cols] of tables) {
        const started = Date.now()
        const colList = cols.map((c) => qi(c.name)).join(', ')
        const reader = await src.unsafe(`copy (select ${colList} from public.${qi(t)}) to stdout`).readable()
        const writer = await tx.unsafe(`copy public.${qi(t)} (${colList}) from stdin`).writable()
        await pipeline(reader, writer)
        const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${qi(t)}`)
        if (n !== srcCounts.get(t)) {
          throw new ImportError(`${t}: copied ${n} rows but source snapshot has ${srcCounts.get(t)} — rolled back`)
        }
        copied.set(t, n)
        log(`  ${t.padEnd(26)} ${String(n).padStart(8)} rows  (${fmtMs(Date.now() - started)})`)
      }

      // Sequences owned by columns (none today — all ids are uuid — but stay correct if one appears).
      const seqs = await tx<{ seq: string; tbl: string; col: string }[]>`
        select s.relname as seq, t.relname as tbl, a.attname as col
        from pg_class s
        join pg_namespace n on n.oid = s.relnamespace and n.nspname = 'public'
        join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
        join pg_class t on t.oid = d.refobjid
        join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
        where s.relkind = 'S'`
      for (const s of seqs) {
        await tx.unsafe(
          `select setval('public.${qi(s.seq)}', coalesce((select max(${qi(s.col)}) from public.${qi(s.tbl)}), 0) + 1, false)`,
        )
        log(`  sequence ${s.seq} reset to max(${s.tbl}.${s.col}) + 1`)
      }
      if (!seqs.length) log('  (no sequences to reset)')
    })
    log(`  total: ${[...copied.values()].reduce((a, b) => a + b, 0)} rows in ${copied.size} tables — committed`)
    return { counts: copied }
  })
}

// ── Step 2: files ────────────────────────────────────────────────────────

export interface StorageObject { bucket: string; name: string; size: number | null }

const PLACEHOLDER = '.emptyFolderPlaceholder'

/** Mirrors src/storage.ts filePath(): MEDIA_DIR/public|private/<bucket>/<path>. */
export function objectFile(mediaDir: string, bucket: string, name: string): string {
  const b = BUCKETS.find((x) => x.id === bucket)
  if (!b) throw new Error(`unknown bucket ${bucket}`)
  return join(resolve(mediaDir), b.public ? 'public' : 'private', bucket, ...name.split('/'))
}

async function listObjects(ctx: Ctx): Promise<{ objects: StorageObject[]; unsafe: StorageObject[]; placeholders: number }> {
  const rows = await readSource(ctx, (src) => src<{ bucket_id: string; name: string; size: string | null }[]>`
    select bucket_id, name, metadata->>'size' as size
    from storage.objects
    where bucket_id in ${src(BUCKETS.map((b) => b.id))}
    order by bucket_id, name`)
  const objects: StorageObject[] = []
  const unsafe: StorageObject[] = []
  let placeholders = 0
  for (const r of rows) {
    const o = { bucket: r.bucket_id, name: r.name, size: r.size == null ? null : Number(r.size) }
    if (o.name.endsWith(PLACEHOLDER)) placeholders++
    else if (isSafeObjectPath(o.name)) objects.push(o)
    else unsafe.push(o)
  }
  return { objects, unsafe, placeholders }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Already on disk and complete? Same size when the source knows it, non-empty otherwise. */
async function isPresent(ctx: Ctx, o: StorageObject): Promise<boolean> {
  const size = await fileSize(objectFile(ctx.cfg.mediaDir, o.bucket, o.name))
  if (size === null) return false
  return o.size === null ? size > 0 : size === o.size
}

/**
 * Download URL for one object.
 *   public bucket : GET {SUPABASE_URL}/storage/v1/object/public/<bucket>/<name>       (no auth)
 *   private bucket: GET {SUPABASE_URL}/storage/v1/object/authenticated/<bucket>/<name>
 *                   apikey: <service key>  [+ Authorization: Bearer <key> when it's a JWT]
 */
export function downloadRequest(cfg: ImportConfig, o: StorageObject): { url: string; headers: Record<string, string> } {
  const base = trimSlash(need(cfg.supabaseUrl, 'SUPABASE_URL'))
  const path = `${encodeURIComponent(o.bucket)}/${o.name.split('/').map(encodeURIComponent).join('/')}`
  const isPublic = BUCKETS.find((b) => b.id === o.bucket)?.public
  if (isPublic) return { url: `${base}/storage/v1/object/public/${path}`, headers: {} }
  const key = need(cfg.serviceKey, 'SUPABASE_SERVICE_KEY')
  const headers: Record<string, string> = { apikey: key }
  // Legacy service_role keys are JWTs and go in Authorization too. New-style `sb_secret_…`
  // keys are not JWTs: send only `apikey` and the API gateway mints the JWT itself.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`
  return { url: `${base}/storage/v1/object/authenticated/${path}`, headers }
}

async function downloadOne(ctx: Ctx, o: StorageObject): Promise<void> {
  const doFetch = ctx.cfg.fetchImpl ?? fetch
  const { url, headers } = downloadRequest(ctx.cfg, o)
  const target = objectFile(ctx.cfg.mediaDir, o.bucket, o.name)
  let lastErr: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200)
        const err = new Error(`HTTP ${res.status} ${body}`.trim())
        // 4xx other than timeout/rate-limit won't get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw Object.assign(err, { permanent: true })
        }
        throw err
      }
      const data = new Uint8Array(await res.arrayBuffer())
      if (o.size !== null && data.byteLength !== o.size) {
        throw new Error(`size mismatch: got ${data.byteLength} bytes, storage says ${o.size}`)
      }
      await mkdir(dirname(target), { recursive: true })
      // Dot-prefixed temp name: can never collide with a real object (isSafeObjectPath forbids a leading dot).
      const tmp = join(dirname(target), `.${process.pid}.${attempt}.${Date.now()}.import-tmp`)
      try {
        await writeFile(tmp, data)
        await rename(tmp, target)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      return
    } catch (err) {
      lastErr = err
      if ((err as { permanent?: boolean }).permanent) break
      if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}

export interface FilesResult {
  total: number
  downloaded: number
  skipped: number
  failed: { bucket: string; name: string; error: string }[]
  unsafe: StorageObject[]
}

export async function stepFiles(ctx: Ctx): Promise<FilesResult> {
  const { log, cfg } = ctx
  const { objects, unsafe, placeholders } = await listObjects(ctx)
  for (const b of BUCKETS) {
    log(`  ${b.id} (${b.public ? 'public' : 'private'}): ${objects.filter((o) => o.bucket === b.id).length} objects`)
  }
  if (placeholders) log(`  ignoring ${placeholders} folder placeholder object(s)`)
  if (unsafe.length) {
    log(`  WARNING: ${unsafe.length} object(s) with unsafe names are skipped (the app could never serve them):`)
    for (const o of unsafe.slice(0, 50)) log(`    - ${o.bucket}/${o.name}`)
  }

  const todo: StorageObject[] = []
  let skipped = 0
  for (const o of objects) {
    if (await isPresent(ctx, o)) skipped++
    else todo.push(o)
  }

  if (!ctx.yes) {
    log(`DRY RUN — ${todo.length} file(s) to download into ${resolve(cfg.mediaDir)}, ${skipped} already present`)
    return { total: objects.length, downloaded: 0, skipped, failed: [], unsafe }
  }

  const failed: FilesResult['failed'] = []
  let downloaded = 0
  let next = 0
  let lastReport = Date.now()
  const worker = async () => {
    while (next < todo.length) {
      const o = todo[next++]
      try {
        await downloadOne(ctx, o)
        downloaded++
      } catch (err) {
        failed.push({ bucket: o.bucket, name: o.name, error: (err as Error).message })
      }
      if (Date.now() - lastReport > 5000) {
        lastReport = Date.now()
        log(`  … ${downloaded + failed.length}/${todo.length} (${failed.length} failed)`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, todo.length) }, worker))

  log(`  downloaded ${downloaded}, skipped ${skipped} (already present), failed ${failed.length}`)
  for (const f of failed) log(`    FAILED ${f.bucket}/${f.name}: ${f.error}`)
  return { total: objects.length, downloaded, skipped, failed, unsafe }
}

// ── Step 3: rewrite URLs ─────────────────────────────────────────────────

const TEXTY = new Set(['text', 'varchar', 'bpchar', '_text', '_varchar', 'json', 'jsonb'])

async function textColumns(sql: Sql | postgres.TransactionSql<{}>): Promise<{ table: string; col: string; udt: string }[]> {
  const out: { table: string; col: string; udt: string }[] = []
  for (const [t, cols] of await publicTables(sql)) {
    for (const c of cols) if (TEXTY.has(c.udt)) out.push({ table: t, col: c.name, udt: c.udt })
  }
  return out
}

/** `col::text` cast back to the column's own type. */
function castBack(udt: string): string {
  return { json: 'json', jsonb: 'jsonb', _text: 'text[]', _varchar: 'varchar[]', bpchar: 'bpchar' }[udt] ?? 'text'
}

export async function stepRewriteUrls(ctx: Ctx): Promise<{ updated: Map<string, number>; leftovers: Map<string, number> }> {
  const { log, cfg } = ctx
  const from = oldPublicPrefix(cfg)
  const to = newPublicPrefix(cfg)
  const host = new URL(need(cfg.supabaseUrl, 'SUPABASE_URL')).host
  log(`  ${from}  →  ${to}`)
  const target = ctx.target()
  const cols = await textColumns(target)
  const updated = new Map<string, number>()

  await target.begin(async (tx) => {
    for (const { table: t, col, udt } of cols) {
      const where = `strpos(${qi(col)}::text, $1) > 0`
      if (!ctx.yes) {
        const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${qi(t)} where ${where}`, [from])
        if (n) updated.set(`${t}.${col}`, n)
        continue
      }
      const res = await tx.unsafe(
        `update public.${qi(t)} set ${qi(col)} = replace(${qi(col)}::text, $1, $2)::${castBack(udt)} where ${where}`,
        [from, to],
      )
      if (res.count) updated.set(`${t}.${col}`, res.count)
    }
  })
  if (updated.size) {
    log(ctx.yes ? '  rows updated per column:' : '  DRY RUN — rows that would be updated per column:')
    table([...updated].map(([k, v]) => [k, v]), log)
  } else {
    log('  nothing to rewrite (no column contains the old prefix)')
  }

  // Anything still pointing at Supabase (other URL shapes: signed URLs, render/image URLs, …).
  const leftovers = new Map<string, number>()
  for (const { table: t, col } of cols) {
    const rows = await target.unsafe<{ n: number; sample: string | null }[]>(
      `select count(*)::int as n, min(left(${qi(col)}::text, 160)) as sample
       from public.${qi(t)} where strpos(${qi(col)}::text, $1) > 0`,
      [host],
    )
    if (rows[0].n) {
      leftovers.set(`${t}.${col}`, rows[0].n)
      log(`  WARNING: ${t}.${col} still mentions ${host} in ${rows[0].n} row(s), e.g. ${rows[0].sample}`)
    }
  }
  if (!leftovers.size) log(`  no remaining references to ${host}`)
  return { updated, leftovers }
}

// ── Step 4: verify ───────────────────────────────────────────────────────

async function walkFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue // temp files
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkFiles(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

export interface VerifyResult { ok: boolean; problems: string[] }

export async function stepVerify(ctx: Ctx): Promise<VerifyResult> {
  const { log, cfg } = ctx
  const problems: string[] = []
  const target = ctx.target()

  // Row counts.
  const tgtTables = await publicTables(target)
  const names = [...tgtTables.keys()].sort()
  const srcCounts = await readSource(ctx, (src) => countRows(src, names))
  const tgtCounts = await countRows(target, names)
  const rows: (string | number)[][] = [['table', 'source', 'target', '']]
  for (const t of names) {
    const s = srcCounts.get(t)!, g = tgtCounts.get(t)!
    rows.push([t, s, g, s === g ? 'ok' : 'MISMATCH'])
    if (s !== g) problems.push(`row count ${t}: source ${s}, target ${g}`)
  }
  table(rows, log)

  // Files.
  const { objects } = await listObjects(ctx)
  for (const b of BUCKETS) {
    const expected = objects.filter((o) => o.bucket === b.id)
    let missing = 0
    const examples: string[] = []
    for (const o of expected) {
      if (!(await isPresent(ctx, o))) {
        missing++
        if (examples.length < 5) examples.push(o.name)
      }
    }
    const onDisk = (await walkFiles(join(resolve(cfg.mediaDir), b.public ? 'public' : 'private', b.id))).length
    log(`  ${b.id}: ${expected.length} objects in storage, ${onDisk} files on disk, ${missing} missing/incomplete`)
    if (missing) problems.push(`${b.id}: ${missing} file(s) missing or incomplete (e.g. ${examples.join(', ')})`)
    if (onDisk > expected.length - missing) log(`    note: ${onDisk - (expected.length - missing)} extra file(s) on disk not in storage (harmless)`)
  }

  // Sample photo URLs → files.
  const prefix = cfg.mediaPublicUrl ? newPublicPrefix(cfg) : null
  const oldPrefix = cfg.supabaseUrl ? oldPublicPrefix(cfg) : null
  const sample = await target<{ url: string }[]>`select url from user_photos order by random() limit 5`
  if (!sample.length) log('  user_photos is empty — no URL sample to check')
  for (const { url } of sample) {
    if (oldPrefix && url.startsWith(oldPrefix)) {
      problems.push(`user_photos.url not rewritten: ${url}`)
      log(`  photo ${url}  NOT REWRITTEN`)
      continue
    }
    if (!prefix || !url.startsWith(prefix)) {
      log(`  photo ${url}  (not a media URL — skipped)`)
      continue
    }
    const rest = decodeURIComponent(url.slice(prefix.length).split('?')[0])
    const [bucket, ...name] = rest.split('/')
    const file = BUCKETS.some((b) => b.id === bucket && b.public) && isSafeObjectPath(name.join('/'))
      ? objectFile(cfg.mediaDir, bucket, name.join('/'))
      : null
    const ok = file !== null && (await fileSize(file)) !== null
    log(`  photo ${url}  ${ok ? 'ok' : 'FILE MISSING'}`)
    if (!ok) problems.push(`user_photos.url has no file on disk: ${url}`)
  }

  for (const p of problems) log(`  PROBLEM: ${p}`)
  log(problems.length ? `  verify FAILED (${problems.length} problem(s))` : '  verify OK')
  return { ok: problems.length === 0, problems }
}

// ── Orchestration ────────────────────────────────────────────────────────

export type Step = 'data' | 'files' | 'rewrite-urls' | 'verify'
const ORDER: Step[] = ['data', 'files', 'rewrite-urls', 'verify']

export function parseArgs(argv: string[]): { steps: Step[]; yes: boolean } {
  const flags = new Set(argv)
  for (const f of flags) {
    if (!['--data', '--files', '--rewrite-urls', '--verify', '--all', '--yes'].includes(f)) {
      throw new ImportError(`unknown argument ${f}`)
    }
  }
  const steps = flags.has('--all') ? ORDER : ORDER.filter((s) => flags.has(`--${s}`))
  if (!steps.length) throw new ImportError('nothing to do: pass --data, --files, --rewrite-urls, --verify or --all (and --yes to apply)')
  return { steps, yes: flags.has('--yes') }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ImportConfig {
  return {
    sourceUrl: env.SOURCE_DATABASE_URL,
    targetUrl: env.TARGET_DATABASE_URL,
    supabaseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
    mediaDir: env.MEDIA_DIR || '/var/lib/luma/media',
    mediaPublicUrl: env.MEDIA_PUBLIC_URL,
    sourceStartupReadOnly: env.SOURCE_NO_STARTUP_OPTIONS !== '1',
  }
}

export interface RunResult {
  ok: boolean
  data?: Awaited<ReturnType<typeof stepData>>
  files?: FilesResult
  rewrite?: Awaited<ReturnType<typeof stepRewriteUrls>>
  verify?: VerifyResult
}

/** Runs the steps in order; stops at the first failing step. Never throws for step failures. */
export async function runImport(cfg: ImportConfig, steps: Step[], yes: boolean): Promise<RunResult> {
  const log = cfg.log ?? ((l: string) => console.log(l))
  let source: Sql | undefined
  let target: Sql | undefined
  const ctx: Ctx = {
    cfg, yes, log,
    source: () => (source ??= openSource(cfg)),
    target: () => (target ??= openTarget(cfg)),
  }
  const result: RunResult = { ok: true }
  const t0 = Date.now()
  log(`luma import — steps: ${steps.join(', ')}${yes ? '' : '  (DRY RUN: add --yes to apply)'}`)
  try {
    for (const step of ORDER.filter((s) => steps.includes(s))) {
      const started = Date.now()
      log(`\n== ${step} ==`)
      if (step === 'data') result.data = await stepData(ctx)
      if (step === 'files') {
        result.files = await stepFiles(ctx)
        if (result.files.failed.length) result.ok = false
      }
      if (step === 'rewrite-urls') result.rewrite = await stepRewriteUrls(ctx)
      if (step === 'verify') {
        result.verify = await stepVerify(ctx)
        if (!result.verify.ok) result.ok = false
      }
      log(`-- ${step} done in ${fmtMs(Date.now() - started)}${result.ok ? '' : ' (with failures)'}`)
      if (!result.ok) break
    }
  } catch (err) {
    result.ok = false
    log(`\nFAILED: ${(err as Error).message}`)
  } finally {
    await Promise.all([source?.end(), target?.end()])
  }
  log(`\n${result.ok ? 'OK' : 'FAILED'} — total ${fmtMs(Date.now() - t0)}`)
  return result
}

// CLI entry: `tsx scripts/import-from-supabase.ts --all --yes`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { steps, yes } = parseArgs(process.argv.slice(2))
    const { ok } = await runImport(configFromEnv(), steps, yes)
    process.exitCode = ok ? 0 : 1
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 2
  }
}
