import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { db } from '../src/db.js'
import {
  generateReferralCode,
  parseRefCode,
  ensureReferralCode,
  stashReferralClaim,
  captureReferralAttribution,
} from '../src/referrals/attribution.js'
import { chainable } from './admin-helpers.js'

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

describe('generateReferralCode', () => {
  it('returns 8 chars, all within the alphabet', () => {
    const code = generateReferralCode()
    expect(code).toHaveLength(8)
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true)
  })

  it('two calls differ', () => {
    const a = generateReferralCode()
    const b = generateReferralCode()
    expect(a).not.toEqual(b)
  })
})

describe('parseRefCode', () => {
  it('extracts the bare code from a ref_ payload', () => {
    expect(parseRefCode('ref_x9km2pqr')).toEqual('x9km2pqr')
  })

  it('returns null for a payload without the ref_ prefix', () => {
    expect(parseRefCode('support')).toBeNull()
  })

  it('returns null for an empty code after the prefix', () => {
    expect(parseRefCode('ref_')).toBeNull()
  })

  it('returns null for null', () => {
    expect(parseRefCode(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseRefCode(undefined)).toBeNull()
  })

  it('returns null for uppercase/invalid characters', () => {
    expect(parseRefCode('ref_UPPER!!')).toBeNull()
  })

  it('returns null when the code exceeds the max length of 32', () => {
    expect(parseRefCode('ref_' + 'a'.repeat(33))).toBeNull()
  })

  it('accepts a code at the max length of 32', () => {
    const code = 'a'.repeat(32)
    expect(parseRefCode('ref_' + code)).toEqual(code)
  })
})

describe('ensureReferralCode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the existing code without updating when present', async () => {
    const updateSpy = vi.fn()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: { referral_code: 'existingcode' }, error: null }),
          update: updateSpy,
        } as any
      }
      return chainable({ data: null })
    })
    const code = await ensureReferralCode('user-1')
    expect(code).toEqual('existingcode')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('generates and persists a new code when none is present', async () => {
    const updates: any[] = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: { referral_code: null }, error: null }),
          update: (p: any) => {
            updates.push(p)
            return chainable({ error: null })
          },
        } as any
      }
      return chainable({ data: null })
    })
    const code = await ensureReferralCode('user-1')
    expect(code).not.toBeNull()
    expect(code).toHaveLength(8)
    expect(updates[0]).toEqual({ referral_code: code })
  })

  it('returns null when the select errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return { select: () => chainable({ data: null, error: { message: 'db down' } }) } as any
      }
      return chainable({ data: null })
    })
    const code = await ensureReferralCode('user-1')
    expect(code).toBeNull()
  })

  it('never throws — returns null even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(ensureReferralCode('user-1')).resolves.toBeNull()
  })
})

describe('stashReferralClaim', () => {
  beforeEach(() => vi.clearAllMocks())

  it('upserts telegram_id + code into referral_claims', async () => {
    const upsertSpy = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_claims') {
        return { upsert: upsertSpy } as any
      }
      return chainable({ data: null })
    })
    await stashReferralClaim(123, 'abc123')
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    const [payload] = upsertSpy.mock.calls[0]
    expect(payload).toMatchObject({ telegram_id: 123, code: 'abc123' })
  })

  it('never throws — resolves even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(stashReferralClaim(123, 'abc123')).resolves.toBeUndefined()
  })
})

describe('captureReferralAttribution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('with a ref_<code> startParam: looks up the referrer, updates referred_by, inserts referrals', async () => {
    const userUpdates: any[] = []
    const referralInserts: any[] = []
    const claimSelect = vi.fn()
    const claimDelete = vi.fn()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: { id: 'referrer-1' }, error: null }),
          update: (p: any) => {
            userUpdates.push(p)
            return chainable({ error: null })
          },
        } as any
      }
      if (table === 'referrals') {
        return {
          insert: (p: any) => {
            referralInserts.push(p)
            return chainable({ error: null })
          },
        } as any
      }
      if (table === 'referral_claims') {
        return { select: claimSelect, delete: claimDelete } as any
      }
      return chainable({ data: null })
    })

    await captureReferralAttribution('new-user-1', 999, 'ref_abc123')

    expect(claimSelect).not.toHaveBeenCalled()
    expect(userUpdates).toEqual([{ referred_by: 'referrer-1' }])
    expect(referralInserts).toEqual([{ referrer_id: 'referrer-1', referred_id: 'new-user-1' }])
    expect(claimDelete).not.toHaveBeenCalled()
  })

  it('with no startParam but a pending claim: same outcome, and deletes the claim', async () => {
    const userUpdates: any[] = []
    const referralInserts: any[] = []
    const claimDelete = vi.fn(() => chainable({ error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: { id: 'referrer-1' }, error: null }),
          update: (p: any) => {
            userUpdates.push(p)
            return chainable({ error: null })
          },
        } as any
      }
      if (table === 'referrals') {
        return {
          insert: (p: any) => {
            referralInserts.push(p)
            return chainable({ error: null })
          },
        } as any
      }
      if (table === 'referral_claims') {
        return {
          select: () => chainable({ data: { code: 'abc123' }, error: null }),
          delete: claimDelete,
        } as any
      }
      return chainable({ data: null })
    })

    await captureReferralAttribution('new-user-1', 999, null)

    expect(userUpdates).toEqual([{ referred_by: 'referrer-1' }])
    expect(referralInserts).toEqual([{ referrer_id: 'referrer-1', referred_id: 'new-user-1' }])
    expect(claimDelete).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the code is unknown (no referrer found)', async () => {
    const userUpdate = vi.fn()
    const referralInsert = vi.fn()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: null, error: null }),
          update: userUpdate,
        } as any
      }
      if (table === 'referrals') {
        return { insert: referralInsert } as any
      }
      return chainable({ data: null })
    })

    await expect(
      captureReferralAttribution('new-user-1', 999, 'ref_unknown1')
    ).resolves.toBeUndefined()
    expect(userUpdate).not.toHaveBeenCalled()
    expect(referralInsert).not.toHaveBeenCalled()
  })

  it('does nothing when the referrer id equals the new user id (self-referral)', async () => {
    const userUpdate = vi.fn()
    const referralInsert = vi.fn()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => chainable({ data: { id: 'same-user' }, error: null }),
          update: userUpdate,
        } as any
      }
      if (table === 'referrals') {
        return { insert: referralInsert } as any
      }
      return chainable({ data: null })
    })

    await captureReferralAttribution('same-user', 999, 'ref_abc123')
    expect(userUpdate).not.toHaveBeenCalled()
    expect(referralInsert).not.toHaveBeenCalled()
  })

  it('does nothing when there is no startParam and no pending claim', async () => {
    const userUpdate = vi.fn()
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'referral_claims') {
        return { select: () => chainable({ data: null, error: null }) } as any
      }
      if (table === 'users') {
        return { select: () => chainable({ data: null }), update: userUpdate } as any
      }
      return chainable({ data: null })
    })

    await expect(captureReferralAttribution('new-user-1', 999, null)).resolves.toBeUndefined()
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('never throws — resolves even if the client throws', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(
      captureReferralAttribution('new-user-1', 999, 'ref_abc123')
    ).resolves.toBeUndefined()
  })
})
