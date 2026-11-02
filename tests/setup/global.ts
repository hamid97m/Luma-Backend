import postgres from 'postgres'
import { migrate } from '../../src/migrate.js'

/**
 * Builds `luma_template` (baseline schema + migrations) once per test run; each
 * worker clones it into its own database (see worker-db.ts). Needs a local
 * Postgres: `pnpm test:db:up` (Docker) or TEST_PG_URL pointing at one.
 */
export const TEST_PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:luma@localhost:54329'
const RUN = process.env.LUMA_TEST_RUN ?? 'local'
export const TEMPLATE = `luma_tpl_${RUN}`
export const WORKER_DB_PREFIX = `luma_test_${RUN}_`

export default async function setup() {
  const admin = postgres(`${TEST_PG_URL}/postgres`, { max: 1, onnotice: () => {} })
  try {
    await admin`select 1`
  } catch (err) {
    await admin.end()
    throw new Error(`Test Postgres not reachable at ${TEST_PG_URL} — run \`pnpm test:db:up\`. (${(err as Error).message})`)
  }
  await admin.unsafe(`drop database if exists "${TEMPLATE}" with (force)`)
  await admin.unsafe(`create database "${TEMPLATE}"`)
  await admin.end()

  const tpl = postgres(`${TEST_PG_URL}/${TEMPLATE}`, { max: 1, onnotice: () => {} })
  await migrate(tpl as never)
  await tpl.end()

  // Teardown: drop this run's template and worker databases only.
  return async () => {
    const a = postgres(`${TEST_PG_URL}/postgres`, { max: 1, onnotice: () => {} })
    const mine = await a<{ datname: string }[]>`
      select datname from pg_database where datname = ${TEMPLATE} or starts_with(datname, ${WORKER_DB_PREFIX})`
    for (const { datname } of mine) await a.unsafe(`drop database if exists "${datname}" with (force)`)
    await a.end()
  }
}
