import { vi } from 'vitest'
import { sql } from './db.js'

/**
 * Fixtures for the profile / photos / moderation tests.
 *
 * Storage still goes through supabase-js (`db.storage`), so those tests mock it:
 *   vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))
 * and install `storageMock()` as the bucket returned by `db.storage.from`.
 */
export function storageMock(publicUrl = (path: string) => `https://cdn.test/profile-photos/${path}`) {
  return {
    remove: vi.fn().mockResolvedValue({ error: null }),
    upload: vi.fn().mockResolvedValue({ error: null }),
    download: vi.fn().mockResolvedValue({ data: new Blob(['img'], { type: 'image/jpeg' }), error: null }),
    createSignedUploadUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://cdn.test/signed-upload' }, error: null }),
    getPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: publicUrl(path) } })),
  }
}

/**
 * Run `fn` while every `op` on `table` fails inside Postgres (a BEFORE trigger
 * that raises). Simulates the DB errors the supabase-js mocks used to return.
 * Row-level: only fires when the statement actually touches a row.
 */
export async function withFailingWrites<T>(
  table: string,
  op: 'insert' | 'update' | 'delete',
  fn: () => Promise<T>,
): Promise<T> {
  const name = `test_fail_${table}_${op}`
  await sql.unsafe(`
    create or replace function ${name}() returns trigger language plpgsql as $$
    begin raise exception 'forced ${op} failure on ${table}'; end $$`)
  await sql.unsafe(`create trigger ${name} before ${op} on ${table} for each row execute function ${name}()`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`drop trigger if exists ${name} on ${table}`)
    await sql.unsafe(`drop function if exists ${name}()`)
  }
}

/** Run `fn` while `table` does not exist (renamed away), so any read of it fails. */
export async function withMissingTable<T>(table: string, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`alter table ${table} rename to ${table}__hidden`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`alter table ${table}__hidden rename to ${table}`)
  }
}

/** Insert a pending report against `reportedId` (reporter is created on the fly). */
export async function createReport(reportedId: string, overrides: Record<string, unknown> = {}) {
  const [{ id: reporterId }] = await sql`
    insert into users (telegram_id, name, age, gender, looking_for, account_status)
    values (${Math.floor(Math.random() * 1e12) + 5e12}, 'Reporter', 30, 'woman', 'men', 'active')
    returning id`
  const [row] = await sql`
    insert into reports ${sql({
      reporter_id: reporterId, reported_id: reportedId, context: 'discovery', reason: 'fake', ...overrides,
    })}
    returning *`
  return row
}
