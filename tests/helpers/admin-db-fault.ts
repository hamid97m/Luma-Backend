import { sql } from './db.js'

/** Run `fn` while `table` is unreachable (renamed away), to exercise a route's
 *  DB-error branch against the real database. Restores the table afterwards.
 *  The rename only affects this worker's own test database. */
export async function withTableBroken<T>(table: string, fn: () => Promise<T>): Promise<T> {
  // alter table … rename works for views too.
  await sql.unsafe(`alter table "${table}" rename to "${table}__broken"`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`alter table "${table}__broken" rename to "${table}"`)
  }
}

/** Run `fn` while every `op` (insert/update/delete) on `table` raises, to
 *  exercise a write's error branch. Drops the trigger afterwards. */
export async function withFailingWrite<T>(
  table: string, op: 'insert' | 'update' | 'delete', fn: () => Promise<T>,
): Promise<T> {
  await sql.unsafe(`
    create or replace function test_fail_write() returns trigger language plpgsql as
    $$ begin raise exception 'injected failure'; end $$`)
  await sql.unsafe(`create trigger test_fail_write before ${op} on "${table}" for each row execute function test_fail_write()`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`drop trigger test_fail_write on "${table}"`)
  }
}
