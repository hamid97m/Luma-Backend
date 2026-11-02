import { sql } from './db.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as storage from '../../src/storage.js'

/**
 * Fixtures for the profile / photos / moderation tests.
 *
 * Storage is the real local-disk module (src/storage.ts) writing into the
 * per-worker temp MEDIA_DIR set up in tests/setup/worker-db.ts.
 */
export const PHOTO_URL_BASE = 'http://api.test/media/profile-photos'

/** On-disk location of a profile photo object (`<userId>/<photoId>`). */
export function photoFile(userId: string, photoId: string): string {
  return join(process.env.MEDIA_DIR!, 'public', 'profile-photos', userId, photoId)
}

export function photoFileExists(userId: string, photoId: string): boolean {
  return existsSync(photoFile(userId, photoId))
}

/** Write a profile photo object to disk, as a client upload would. */
export async function seedPhotoFile(userId: string, photoId: string, bytes: Uint8Array = Buffer.from('img')) {
  await storage.upload('profile-photos', `${userId}/${photoId}`, bytes)
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
