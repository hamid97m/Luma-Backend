import { sql } from '../../src/db.js'

/**
 * Failure injection for real-DB tests (bot / support / broadcasts / fake liker /
 * admin premium). Installs a statement-level trigger that makes every `op` on
 * `table` raise, standing in for the old "supabase returned { error }" mocks.
 * Each test file has its own database, so call `clearFailures()` in `afterEach`
 * (`resetDb()` truncates rows but keeps triggers).
 */
export async function failOn(table: string, op: 'insert' | 'update' | 'delete'): Promise<void> {
  await sql.unsafe(`
    create or replace function luma_test_fail() returns trigger language plpgsql as $$
    begin raise exception 'injected failure on %', tg_table_name; end $$`)
  await sql.unsafe(
    `create trigger "luma_test_fail_${op}" before ${op} on "${table}" for each statement execute function luma_test_fail()`,
  )
}

/** Make every query on `table` fail (incl. SQL functions reading it) by renaming it away. */
export async function failReadsOf(table: string): Promise<void> {
  await sql.unsafe(`alter table "${table}" rename to "${table}__luma_test_hidden"`)
}

/** Drop every injected failure (triggers + hidden tables). */
export async function clearFailures(): Promise<void> {
  const triggers = await sql<{ tgname: string; relname: string }[]>`
    select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname like 'luma_test_fail_%'`
  for (const { tgname, relname } of triggers) await sql.unsafe(`drop trigger "${tgname}" on "${relname}"`)
  const hidden = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' and tablename like '%__luma_test_hidden'`
  for (const { tablename } of hidden) {
    await sql.unsafe(`alter table "${tablename}" rename to "${tablename.replace(/__luma_test_hidden$/, '')}"`)
  }
}
