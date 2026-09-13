import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { db } from '../src/db.js'
import { getReferralConfig, updateReferralConfig } from '../src/referrals/config.js'
import { chainable } from './admin-helpers.js'

describe('getReferralConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the config when the row exists', async () => {
    vi.mocked(db.from).mockImplementation((table: string) =>
      table === 'referral_config'
        ? chainable({ data: { enabled: true }, error: null })
        : chainable({ data: null }))
    const cfg = await getReferralConfig()
    expect(cfg).toEqual({ enabled: true })
  })

  it('returns null when the query errors', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: null, error: { message: 'relation does not exist' } }))
    const cfg = await getReferralConfig()
    expect(cfg).toBeNull()
  })

  it('returns null when no row is found', async () => {
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null, error: null }))
    const cfg = await getReferralConfig()
    expect(cfg).toBeNull()
  })

  it('never throws — returns null even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(getReferralConfig()).resolves.toBeNull()
  })
})

describe('updateReferralConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends enabled + updated_at in the update payload and returns the fresh row', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_config') {
        return {
          update: (p: any) => {
            updates.push(p)
            return chainable({ data: { enabled: true }, error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateReferralConfig({ enabled: true })
    expect(cfg).toEqual({ enabled: true })
    expect(updates[0]).toMatchObject({ enabled: true })
    expect(updates[0]).toHaveProperty('updated_at')
  })

  it('omits enabled from the update payload when not provided in the patch', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_config') {
        return {
          update: (p: any) => {
            updates.push(p)
            return chainable({ data: { enabled: false }, error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateReferralConfig({})
    expect(cfg).toEqual({ enabled: false })
    expect(updates[0]).not.toHaveProperty('enabled')
    expect(updates[0]).toHaveProperty('updated_at')
  })

  it('returns null when the update errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_config') {
        return { update: () => chainable({ data: null, error: { message: 'db down' } }) } as any
      }
      return chainable({ data: null })
    })
    const cfg = await updateReferralConfig({ enabled: true })
    expect(cfg).toBeNull()
  })

  it('never throws — returns null even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(updateReferralConfig({ enabled: true })).resolves.toBeNull()
  })
})
