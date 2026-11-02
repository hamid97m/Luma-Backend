import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getFakeLikerConfig, updateFakeLikerConfig, getLastFakeLikerRunAt } from '../src/jobs/fakeLikerConfig.js'
import { resetDb, insertRow, sql } from './helpers/db.js'
import { failOn, failReadsOf, clearFailures } from './helpers/bot-support.js'

beforeEach(resetDb)
afterEach(clearFailures)

describe('getFakeLikerConfig', () => {
  it('returns the camelCase config when the row exists', async () => {
    await sql`update fake_liker_config set enabled = true, max_targets_per_run = 50`
    expect(await getFakeLikerConfig()).toEqual({ enabled: true, maxTargetsPerRun: 50 })
  })

  it('returns the fresh-install defaults', async () => {
    expect(await getFakeLikerConfig()).toEqual({ enabled: false, maxTargetsPerRun: 100 })
  })

  it('returns null when no row is found', async () => {
    await sql`delete from fake_liker_config`
    expect(await getFakeLikerConfig()).toBeNull()
  })

  it('never throws — returns null when the query errors', async () => {
    await failReadsOf('fake_liker_config')
    await expect(getFakeLikerConfig()).resolves.toBeNull()
  })
})

describe('updateFakeLikerConfig', () => {
  it('updates only the provided fields and stamps updated_at', async () => {
    await sql`update fake_liker_config set max_targets_per_run = 77, updated_at = '2020-01-01T00:00:00Z'`
    const cfg = await updateFakeLikerConfig({ enabled: true })
    expect(cfg).toEqual({ enabled: true, maxTargetsPerRun: 77 })
    const [row] = await sql`select updated_at from fake_liker_config`
    expect(Date.now() - new Date(row.updated_at).getTime()).toBeLessThan(10_000)
  })

  it('maps maxTargetsPerRun to the snake_case column', async () => {
    const cfg = await updateFakeLikerConfig({ maxTargetsPerRun: 200 })
    expect(cfg).toEqual({ enabled: false, maxTargetsPerRun: 200 })
    const [row] = await sql`select max_targets_per_run from fake_liker_config`
    expect(row.max_targets_per_run).toBe(200)
  })

  it('returns null when the row is missing', async () => {
    await sql`delete from fake_liker_config`
    expect(await updateFakeLikerConfig({ enabled: true })).toBeNull()
  })

  it('never throws — returns null when the update errors', async () => {
    await failOn('fake_liker_config', 'update')
    await expect(updateFakeLikerConfig({ enabled: true })).resolves.toBeNull()
  })
})

describe('getLastFakeLikerRunAt', () => {
  const run = (started_at: string) =>
    insertRow('fake_liker_runs', { trigger: 'schedule', started_at, finished_at: started_at })

  it('returns the newest run start, or null when there are none', async () => {
    expect(await getLastFakeLikerRunAt()).toBeNull()
    await run('2026-09-01T00:00:00.000Z')
    await run('2026-09-03T00:00:00.000Z')
    await run('2026-09-02T00:00:00.000Z')
    expect(await getLastFakeLikerRunAt()).toBe('2026-09-03T00:00:00.000Z')
  })

  it('returns null when the query errors', async () => {
    await failReadsOf('fake_liker_runs')
    expect(await getLastFakeLikerRunAt()).toBeNull()
  })
})
