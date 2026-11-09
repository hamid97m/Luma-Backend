import { sql } from '../../src/db.js'
import { settleMessageWork } from '../../src/messaging/inflight.js'

export { sql }

const SINGLETON_CONFIG_TABLES = [
  'fake_liker_config', 'gift_config', 'moderation_config',
  'premium_config', 'purchase_message_config', 'referral_config',
]

/** Empty every table (keeps the schema), then restore the singleton config rows
 *  a fresh install has. Call in `beforeEach` of tests that touch the database. */
export async function resetDb(): Promise<void> {
  // Fire-and-forget notification work from the previous test must finish
  // first: its claim transaction would deadlock with the TRUNCATE below.
  await settleMessageWork()
  const tables = await sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'`
  if (tables.length) {
    await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`)
  }
  for (const t of SINGLETON_CONFIG_TABLES) await sql.unsafe(`insert into ${t} (id) values (true)`)
}

/** Insert one row and return it (all columns). */
export async function insertRow<T = Record<string, any>>(table: string, row: Record<string, unknown>): Promise<T> {
  const [created] = await sql`insert into ${sql(table)} ${sql(row)} returning *`
  return created as T
}

let telegramIdSeq = 1_000_000

/** A complete, active user; override any column. */
export async function createUser(overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  telegramIdSeq += 1
  return insertRow('users', {
    telegram_id: telegramIdSeq,
    name: 'Test User',
    age: 28,
    gender: 'man',
    looking_for: 'women',
    account_status: 'active',
    ...overrides,
  })
}

/** Match row with user ids ordered as the app stores them (user1_id < user2_id is NOT assumed). */
export async function createMatch(user1_id: string, user2_id: string, overrides: Record<string, unknown> = {}) {
  return insertRow('matches', { user1_id, user2_id, ...overrides })
}

export async function createPhoto(user_id: string, position = 0, overrides: Record<string, unknown> = {}) {
  return insertRow('user_photos', {
    user_id, position, url: `https://media.test/profile-photos/${user_id}/${position}.jpg`, ...overrides,
  })
}
