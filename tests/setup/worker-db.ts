import { afterAll } from 'vitest'
import postgres from 'postgres'

// One database per Vitest worker, cloned from the template built in global.ts.
// Must run before any test imports src/db.ts (which reads DATABASE_URL once).
const TEST_PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:luma@localhost:54329'
const RUN = process.env.LUMA_TEST_RUN ?? 'local'
const name = `luma_test_${RUN}_${process.env.VITEST_POOL_ID ?? '0'}`

const admin = postgres(`${TEST_PG_URL}/postgres`, { max: 1, onnotice: () => {} })
const [{ exists }] = await admin<{ exists: boolean }[]>`
  select exists (select 1 from pg_database where datname = ${name}) as exists`
if (!exists) {
  await admin.unsafe(`create database "${name}" template "luma_tpl_${RUN}"`).catch((err) => {
    if ((err as { code?: string }).code !== '42P04') throw err // already created by a racing file
  })
}
await admin.end()

process.env.DATABASE_URL = `${TEST_PG_URL}/${name}`

afterAll(async () => {
  // Files that vi.mock('../src/db.js') without an `sql` export throw on access.
  try {
    const { sql } = await import('../../src/db.js')
    await sql.end()
  } catch {
    /* mocked db module — no pool to close */
  }
})
