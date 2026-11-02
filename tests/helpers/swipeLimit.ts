import { sql } from './db.js'

/**
 * Fault injection on `users` UPDATEs, to drive the swipe-limit's
 * optimistic-concurrency and error paths against a real database:
 *  - 'skip': every UPDATE silently matches nothing (a writer always "loses the race")
 *  - 'fail': every UPDATE raises (a write error)
 * Call `clearUsersUpdateFault()` in afterEach.
 */
export async function usersUpdateFault(mode: 'skip' | 'fail'): Promise<void> {
  const body = mode === 'skip' ? 'return null;' : "raise exception 'injected users update failure';"
  await sql.unsafe(`
    create or replace function test_users_update_fault() returns trigger
    language plpgsql as $$ begin ${body} end $$`)
  await sql.unsafe('drop trigger if exists test_users_update_fault on users')
  await sql.unsafe(`
    create trigger test_users_update_fault before update on users
    for each row execute function test_users_update_fault()`)
}

export async function clearUsersUpdateFault(): Promise<void> {
  await sql.unsafe('drop trigger if exists test_users_update_fault on users')
}
