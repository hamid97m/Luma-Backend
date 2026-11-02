import 'dotenv/config'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReservedSql } from 'postgres'
import type { Sql } from './db.js'

/**
 * Schema migrations for the self-hosted Postgres.
 *
 * - Empty database → load `db/schema.sql` (the baseline) first.
 * - Then run every `db/migrations/*.sql` not yet in `schema_migrations`, in
 *   filename order, each in its own transaction.
 * - A session advisory lock keeps two concurrent runs (e.g. overlapping deploys)
 *   from applying the same file twice.
 *
 * Run with `pnpm db:migrate` (deploy-backend.sh does, before reloading the app).
 */

const LOCK_KEY = 727_001 // arbitrary, constant per app

// A reserved connection has no `begin()`; drive the transaction by hand so the
// advisory lock and the migration share one session.
async function inTransaction(conn: ReservedSql<any>, fn: () => Promise<unknown>): Promise<void> {
  await conn`begin`
  try {
    await fn()
    await conn`commit`
  } catch (err) {
    await conn`rollback`.catch(() => {})
    throw err
  }
}

export interface MigrateResult {
  baselineLoaded: boolean
  applied: string[]
}

export async function migrate(sql: Sql, dbDir = resolve(process.cwd(), 'db')): Promise<MigrateResult> {
  return sql.reserve().then(async (conn) => {
    try {
      await conn`select pg_advisory_lock(${LOCK_KEY})`

      const [{ exists }] = await conn<{ exists: boolean }[]>`
        select exists (select 1 from information_schema.tables
                       where table_schema = 'public' and table_name = 'users') as exists`
      let baselineLoaded = false
      if (!exists) {
        const baseline = await readFile(join(dbDir, 'schema.sql'), 'utf8')
        await inTransaction(conn, () => conn.unsafe(baseline))
        baselineLoaded = true
      }

      await conn`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )`
      const done = new Set((await conn<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name))

      let files: string[] = []
      try {
        files = (await readdir(join(dbDir, 'migrations'))).filter((f) => f.endsWith('.sql')).sort()
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }

      const applied: string[] = []
      for (const name of files) {
        if (done.has(name)) continue
        const body = await readFile(join(dbDir, 'migrations', name), 'utf8')
        await inTransaction(conn, async () => {
          await conn.unsafe(body)
          await conn`insert into schema_migrations (name) values (${name})`
        })
        applied.push(name)
      }
      return { baselineLoaded, applied }
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {})
      conn.release()
    }
  })
}

// CLI entry: `node dist/migrate.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { sql } = await import('./db.js')
  try {
    const { baselineLoaded, applied } = await migrate(sql)
    if (baselineLoaded) console.log('[migrate] empty database: loaded db/schema.sql')
    console.log(applied.length ? `[migrate] applied: ${applied.join(', ')}` : '[migrate] up to date')
  } catch (err) {
    console.error('[migrate] FAILED:', (err as Error).message)
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}
