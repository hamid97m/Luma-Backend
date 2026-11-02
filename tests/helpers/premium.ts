import { sql, insertRow } from './db.js'

/** Premium/payments fixtures (real rows). */

export async function setPremiumConfig(patch: { premium_enabled?: boolean; toman_per_star?: number }) {
  await sql`update premium_config set ${sql(patch)} where id = true`
}

export async function createPlan(overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return insertRow('premium_plans', {
    title: '1 Month', description: 'Best start', price_stars: 100, duration_days: 30, ...overrides,
  })
}

export async function createTx(user_id: string, overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return insertRow('premium_transactions', {
    user_id, plan_title: '1 Month', price_stars: 100, duration_days: 30,
    status: 'pending_payment', source: 'purchase', ...overrides,
  })
}

export async function getTx(id: string): Promise<Record<string, any>> {
  const [row] = await sql`select * from premium_transactions where id = ${id}`
  return row
}

/** Make every write that changes users.premium_until fail with `message`
 *  (simulates the grant's UPDATE failing). Undo with `restoreUserUpdates()`. */
export async function failPremiumUntilUpdates(message: string): Promise<void> {
  await sql.unsafe(`
    create or replace function test_fail_premium_until() returns trigger language plpgsql as $$
    begin raise exception '${message.replace(/'/g, "''")}'; end $$`)
  await sql.unsafe(`
    create trigger test_fail_premium_until before update on users
    for each row when (old.premium_until is distinct from new.premium_until)
    execute function test_fail_premium_until()`)
}

export async function restoreUserUpdates(): Promise<void> {
  await sql.unsafe(`drop trigger if exists test_fail_premium_until on users`)
  await sql.unsafe(`drop function if exists test_fail_premium_until()`)
}

/** created_at `ms` milliseconds ago, as an ISO string. */
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
