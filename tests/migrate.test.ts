import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { mkdtemp, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrate } from '../src/migrate.js'

const TEST_PG_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:luma@localhost:54329'
const DB = `luma_migrate_${process.env.VITEST_POOL_ID ?? '0'}`

describe('migrate', () => {
  let admin: postgres.Sql
  let sql: postgres.Sql
  let dir: string

  beforeAll(async () => {
    admin = postgres(`${TEST_PG_URL}/postgres`, { max: 1, onnotice: () => {} })
    await admin.unsafe(`drop database if exists "${DB}" with (force)`)
    await admin.unsafe(`create database "${DB}"`)
    sql = postgres(`${TEST_PG_URL}/${DB}`, { max: 2, onnotice: () => {} })
    dir = await mkdtemp(join(tmpdir(), 'luma-migrate-'))
    await copyFile(resolve('db/schema.sql'), join(dir, 'schema.sql'))
    await mkdir(join(dir, 'migrations'))
  })

  afterAll(async () => {
    await sql.end()
    await admin.unsafe(`drop database if exists "${DB}" with (force)`)
    await admin.end()
  })

  it('loads the baseline into an empty database', async () => {
    const res = await migrate(sql as never, dir)
    expect(res).toEqual({ baselineLoaded: true, applied: [] })
    const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
    expect(n).toBe(30) // 29 app tables + schema_migrations
  })

  it('applies pending migrations once, in filename order', async () => {
    await writeFile(join(dir, 'migrations', '0002_b.sql'), `insert into t_order (v) values ('b');`)
    await writeFile(join(dir, 'migrations', '0001_a.sql'), `create table t_order (v text); insert into t_order (v) values ('a');`)
    expect((await migrate(sql as never, dir)).applied).toEqual(['0001_a.sql', '0002_b.sql'])
    expect((await migrate(sql as never, dir))).toEqual({ baselineLoaded: false, applied: [] })
    expect((await sql`select v from t_order`).map((r) => r.v)).toEqual(['a', 'b'])
  })

  it('rolls back a failing migration and does not record it', async () => {
    await writeFile(join(dir, 'migrations', '0003_bad.sql'), `insert into t_order (v) values ('c'); select * from no_such_table;`)
    await expect(migrate(sql as never, dir)).rejects.toThrow(/no_such_table/)
    expect((await sql`select v from t_order`).map((r) => r.v)).toEqual(['a', 'b'])
    expect((await sql`select name from schema_migrations where name = '0003_bad.sql'`).length).toBe(0)
  })
})
