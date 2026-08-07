import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { db } from '../src/db.js'
import { getFakeLikerConfig, updateFakeLikerConfig } from '../src/jobs/fakeLikerConfig.js'
import { chainable } from './admin-helpers.js'

describe('getFakeLikerConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the camelCase config when the row exists', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'fake_liker_config'
        ? chainable({ data: { enabled: true, max_targets_per_run: 50 }, error: null })
        : chainable({ data: null }))
    const cfg = await getFakeLikerConfig()
    expect(cfg).toEqual({ enabled: true, maxTargetsPerRun: 50 })
  })

  it('returns null when the query errors', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: null, error: { message: 'relation does not exist' } }))
    const cfg = await getFakeLikerConfig()
    expect(cfg).toBeNull()
  })

  it('returns null when no row is found', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null, error: null }))
    const cfg = await getFakeLikerConfig()
    expect(cfg).toBeNull()
  })

  it('never throws — returns null even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(getFakeLikerConfig()).resolves.toBeNull()
  })
})

describe('updateFakeLikerConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('updates only the provided fields and stamps updated_at', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') {
        return {
          update: (p: any) => {
            updates.push(p)
            return chainable({ data: { enabled: true, max_targets_per_run: 100 }, error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateFakeLikerConfig({ enabled: true })
    expect(cfg).toEqual({ enabled: true, maxTargetsPerRun: 100 })
    expect(updates[0]).toMatchObject({ enabled: true })
    expect(updates[0]).toHaveProperty('updated_at')
    expect(updates[0]).not.toHaveProperty('max_targets_per_run')
  })

  it('maps maxTargetsPerRun to the snake_case column', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') {
        return {
          update: (p: any) => {
            updates.push(p)
            return chainable({ data: { enabled: false, max_targets_per_run: 200 }, error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateFakeLikerConfig({ maxTargetsPerRun: 200 })
    expect(cfg).toEqual({ enabled: false, maxTargetsPerRun: 200 })
    expect(updates[0]).toMatchObject({ max_targets_per_run: 200 })
  })

  it('returns null when the update errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'fake_liker_config') {
        return { update: () => chainable({ data: null, error: { message: 'db down' } }) } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateFakeLikerConfig({ enabled: true })
    expect(cfg).toBeNull()
  })

  it('never throws — returns null even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(updateFakeLikerConfig({ enabled: true })).resolves.toBeNull()
  })
})
