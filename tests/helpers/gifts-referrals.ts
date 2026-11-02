import { sql } from '../../src/db.js'

/**
 * Fault injection for "the old code tolerated this DB error" tests: makes every
 * INSERT/UPDATE on `table` raise until the returned cleanup runs. Only affects
 * this worker's own test database.
 */
export async function failWritesTo(
  table: string,
  ops: 'INSERT' | 'UPDATE' | 'INSERT OR UPDATE' = 'INSERT OR UPDATE',
  when?: string, // optional trigger WHEN condition, e.g. "(new.status = 'sent')"
) {
  const fn = `test_fail_${table}`
  await sql.unsafe(`
    create or replace function ${fn}() returns trigger language plpgsql as $$
    begin raise exception 'injected failure on ${table}'; end $$`)
  await sql.unsafe(`drop trigger if exists ${fn} on "${table}"`)
  await sql.unsafe(`create trigger ${fn} before ${ops} on "${table}" for each row ${when ? `when ${when}` : ''} execute function ${fn}()`)
  return async () => {
    await sql.unsafe(`drop trigger if exists ${fn} on "${table}"`)
    await sql.unsafe(`drop function if exists ${fn}()`)
  }
}

/** A gift transaction row with sensible defaults. */
export async function createGiftTx(buyer_id: string, recipient_id: string, overrides: Record<string, unknown> = {}) {
  const [row] = await sql`
    insert into gift_transactions ${sql({
      buyer_id, recipient_id, context: 'discovery', gift_id: 'g', gift_emoji: '🌹',
      gift_star_cost: 15, charged_stars: 20, markup_stars: 5, status: 'pending_payment',
      ...overrides,
    })}
    returning *`
  return row as Record<string, any>
}

/** Delete a user row while bypassing FKs — simulates "the row is gone" for code
 *  paths that tolerated a missing user even though the schema now forbids it. */
export async function forceDeleteUser(id: string) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`delete from users where id = ${id}`
  })
}
