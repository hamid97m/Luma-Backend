import postgres from 'postgres'
import { migrate } from '../../src/migrate.js'

/**
 * Builds `luma_template` (baseline schema + migrations) once per test run; each
 * worker clones it into its own database (see worker-db.ts). Needs a local
 * Postgres: `pnpm test:db:up` (Docker) or TEST_PG_URL pointing at one.
 */
export const TEST_PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:luma@localhost:54329'
const TEMPLATE = 'luma_template'

export default async function setup() {
  const admin = postgres(`${TEST_PG_URL}/postgres`, { max: 1, onnotice: () => {} })
  try {
    await admin`select 1`
  } catch (err) {
    await admin.end()
    throw new Error(`Test Postgres not reachable at ${TEST_PG_URL} — run \`pnpm test:db:up\`. (${(err as Error).message})`)
  }
  const stale = await admin<{ datname: string }[]>`
    select datname from pg_database where datname = ${TEMPLATE} or datname like 'luma_test_%'`
  for (const { datname } of stale) await admin.unsafe(`drop database "${datname}" with (force)`)
  await admin.unsafe(`create database ${TEMPLATE}`)
  await admin.end()

  const tpl = postgres(`${TEST_PG_URL}/${TEMPLATE}`, { max: 1, onnotice: () => {} })
  await migrate(tpl as never)
  await tpl.end()
}
