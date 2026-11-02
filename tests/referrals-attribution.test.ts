import { describe, it, expect, vi, beforeEach } from 'vitest'
// Wrap randomBytes so collision tests can force a known code; defaults to the real one.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})
import { randomBytes } from 'node:crypto'
import {
  generateReferralCode,
  parseRefCode,
  ensureReferralCode,
  stashReferralClaim,
  captureReferralAttribution,
} from '../src/referrals/attribution.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { failWritesTo } from './helpers/gifts-referrals.js'

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

// generateReferralCode maps each byte to CODE_ALPHABET[b % 31]; all-zero bytes → 'aaaaaaaa'.
const forceCode = () => vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(8) as any)

const userRow = async (id: string) => (await sql`select referral_code, referred_by from users where id = ${id}`)[0]

describe('ensureReferralCode', () => {
  beforeEach(() => resetDb())

  it('returns the existing code without updating when present', async () => {
    const u = await createUser({ referral_code: 'existingcode' })
    expect(await ensureReferralCode(u.id)).toEqual('existingcode')
    expect(randomBytes).not.toHaveBeenCalled()
  })

  it('generates and persists a new code when none is present', async () => {
    const u = await createUser()
    const code = await ensureReferralCode(u.id)
    expect(code).toHaveLength(8)
    expect((await userRow(u.id)).referral_code).toEqual(code)
  })

  it('retries once when the first update hits a unique collision, then succeeds', async () => {
    await createUser({ referral_code: 'aaaaaaaa' })
    const u = await createUser()
    forceCode()
    const code = await ensureReferralCode(u.id)
    expect(code).toHaveLength(8)
    expect(code).not.toEqual('aaaaaaaa')
    expect((await userRow(u.id)).referral_code).toEqual(code)
    expect(randomBytes).toHaveBeenCalledTimes(2)
  })

  it('returns null after exhausting all 3 attempts on repeated collisions', async () => {
    await createUser({ referral_code: 'aaaaaaaa' })
    const u = await createUser()
    forceCode(); forceCode(); forceCode()
    expect(await ensureReferralCode(u.id)).toBeNull()
    expect(randomBytes).toHaveBeenCalledTimes(3)
    expect((await userRow(u.id)).referral_code).toBeNull()
  })

  it('returns null when the user does not exist', async () => {
    expect(await ensureReferralCode('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('never throws — returns null even if the query errors', async () => {
    await expect(ensureReferralCode('not-a-uuid')).resolves.toBeNull()
  })
})

describe('stashReferralClaim', () => {
  beforeEach(() => resetDb())

  it('upserts telegram_id + code into referral_claims (latest code wins)', async () => {
    await stashReferralClaim(123, 'abc123')
    await stashReferralClaim(123, 'def456')
    expect(await sql`select telegram_id, code from referral_claims`).toEqual([{ telegram_id: 123, code: 'def456' }])
  })

  it('never throws — resolves even if the write errors', async () => {
    const cleanup = await failWritesTo('referral_claims')
    try {
      await expect(stashReferralClaim(123, 'abc123')).resolves.toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe('captureReferralAttribution', () => {
  let referrer: Record<string, any>
  let newUser: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    referrer = await createUser({ referral_code: 'abc123' })
    newUser = await createUser({ telegram_id: 999 })
  })

  const referrals = () => sql`select referrer_id, referred_id from referrals`

  it('with a ref_<code> startParam: sets referred_by and inserts referrals; ignores any stashed claim', async () => {
    await createUser({ referral_code: 'other1' })
    await sql`insert into referral_claims (telegram_id, code) values (999, 'other1')`

    await captureReferralAttribution(newUser.id, 999, 'ref_abc123')

    expect((await userRow(newUser.id)).referred_by).toBe(referrer.id)
    expect(await referrals()).toEqual([{ referrer_id: referrer.id, referred_id: newUser.id }])
    // The claim was not used, so it is not deleted.
    expect(await sql`select code from referral_claims`).toEqual([{ code: 'other1' }])
  })

  it('with no startParam but a pending claim: same outcome, and deletes the claim', async () => {
    await sql`insert into referral_claims (telegram_id, code) values (999, 'abc123')`
    await captureReferralAttribution(newUser.id, 999, null)

    expect((await userRow(newUser.id)).referred_by).toBe(referrer.id)
    expect(await referrals()).toEqual([{ referrer_id: referrer.id, referred_id: newUser.id }])
    expect(await sql`select code from referral_claims`).toEqual([])
  })

  it('does nothing when the code is unknown (no referrer found)', async () => {
    await expect(captureReferralAttribution(newUser.id, 999, 'ref_unknown1')).resolves.toBeUndefined()
    expect((await userRow(newUser.id)).referred_by).toBeNull()
    expect(await referrals()).toEqual([])
  })

  it('does nothing when the referrer id equals the new user id (self-referral)', async () => {
    await captureReferralAttribution(referrer.id, 999, 'ref_abc123')
    expect((await userRow(referrer.id)).referred_by).toBeNull()
    expect(await referrals()).toEqual([])
  })

  it('does nothing when there is no startParam and no pending claim', async () => {
    await expect(captureReferralAttribution(newUser.id, 999, null)).resolves.toBeUndefined()
    expect((await userRow(newUser.id)).referred_by).toBeNull()
  })

  it('never throws — resolves even if the queries error', async () => {
    await expect(captureReferralAttribution('not-a-uuid', 999, 'ref_abc123')).resolves.toBeUndefined()
  })

  it('a failed users.update does not short-circuit the referrals insert', async () => {
    const cleanup = await failWritesTo('users', 'UPDATE')
    try {
      await captureReferralAttribution(newUser.id, 999, 'ref_abc123')
    } finally {
      await cleanup()
    }
    expect((await userRow(newUser.id)).referred_by).toBeNull()
    expect(await referrals()).toEqual([{ referrer_id: referrer.id, referred_id: newUser.id }])
  })

  it('a failed referrals insert (already referred) still clears the used claim', async () => {
    const earlier = await createUser({ referral_code: 'first1' })
    await sql`insert into referrals (referrer_id, referred_id) values (${earlier.id}, ${newUser.id})`
    await sql`insert into referral_claims (telegram_id, code) values (999, 'abc123')`

    await expect(captureReferralAttribution(newUser.id, 999, null)).resolves.toBeUndefined()

    expect(await referrals()).toEqual([{ referrer_id: earlier.id, referred_id: newUser.id }])
    expect(await sql`select code from referral_claims`).toEqual([])
  })
})
