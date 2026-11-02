import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
}))
// Icebreakers belong to another area; only the call contract matters here.
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))
import { acceptIntro, dismissIntro, listPendingIntros } from '../src/gifts/service.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { resetDb, createUser, createMatch, createPhoto, sql } from './helpers/db.js'
import { createGiftTx, failWritesTo, forceDeleteUser } from './helpers/gifts-referrals.js'

let buyer: Record<string, any>
let rec: Record<string, any>

beforeEach(async () => {
  await resetDb()
  vi.mocked(seedIcebreakers).mockResolvedValue(undefined)
  buyer = await createUser({ name: 'Ali' })
  rec = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men' })
})

/** A paid discovery gift waiting in the recipient's intros inbox. */
const pendingIntro = (overrides: Record<string, unknown> = {}) =>
  createGiftTx(buyer.id, rec.id, { status: 'sent', intro_status: 'pending', ...overrides })

async function introRow(id: string) {
  const [row] = await sql`select intro_status, match_id from gift_transactions where id = ${id}`
  return row
}
const pair = () => [buyer.id, rec.id].sort()

describe('acceptIntro', () => {
  it('returns not_found when the caller is not the recipient', async () => {
    const intro = await pendingIntro()
    const other = await createUser()
    expect(await acceptIntro(intro.id, other.id)).toEqual({ error: 'not_found' })
    expect((await introRow(intro.id)).intro_status).toBe('pending')
  })

  it('returns not_found for an unknown id and for a malformed (non-uuid) id', async () => {
    expect(await acceptIntro('00000000-0000-0000-0000-000000000000', rec.id)).toEqual({ error: 'not_found' })
    expect(await acceptIntro('tx1', rec.id)).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    const intro = await pendingIntro({ intro_status: 'dismissed' })
    expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'already_handled' })
  })

  it('returns already_handled on a second accept (claim loses the race)', async () => {
    const intro = await pendingIntro()
    expect(await acceptIntro(intro.id, rec.id)).toHaveProperty('matchId')
    expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'already_handled' })
    expect(await sql`select id from matches`).toHaveLength(1)
    expect(await sql`select id from messages`).toHaveLength(1)
  })

  it('concurrent accepts: exactly one wins, one match and one gift message', async () => {
    const intro = await pendingIntro()
    const results = await Promise.all([acceptIntro(intro.id, rec.id), acceptIntro(intro.id, rec.id)])
    expect(results.filter((r) => 'matchId' in r)).toHaveLength(1)
    expect(results.filter((r) => 'error' in r)).toEqual([{ error: 'already_handled' }])
    expect(await sql`select id from matches`).toHaveLength(1)
    expect(await sql`select id from messages`).toHaveLength(1)
  })

  it('creates a match and seeds a gift message for a fresh pending intro', async () => {
    const intro = await pendingIntro()
    const result = await acceptIntro(intro.id, rec.id)

    const matches = await sql`select id, user1_id, user2_id from matches`
    expect(matches).toHaveLength(1)
    expect(result).toEqual({ matchId: matches[0].id })
    // Pair order is normalised (sorted) to satisfy UNIQUE(user1_id, user2_id).
    const [u1, u2] = pair()
    expect(matches[0]).toMatchObject({ user1_id: u1, user2_id: u2 })

    expect(await introRow(intro.id)).toEqual({ intro_status: 'accepted', match_id: matches[0].id })

    const msgs = await sql`select match_id, sender_id, type, gift_transaction_id, body from messages`
    expect(msgs).toEqual([{ match_id: matches[0].id, sender_id: buyer.id, type: 'gift', gift_transaction_id: intro.id, body: null }])

    // Icebreakers follow the gift, buyer's first.
    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith(matches[0].id, [buyer.id, rec.id])
  })

  it('seeds icebreakers only after the gift message is inserted', async () => {
    let giftMessagesAtSeed = -1
    vi.mocked(seedIcebreakers).mockImplementationOnce(async () => {
      giftMessagesAtSeed = (await sql`select id from messages where type = 'gift'`).length
    })
    const intro = await pendingIntro()
    await acceptIntro(intro.id, rec.id)
    expect(giftMessagesAtSeed).toBe(1)
  })

  it('reuses the existing match on a 23505 unique-constraint conflict', async () => {
    const [u1, u2] = pair()
    const existing = await createMatch(u1, u2)
    const intro = await pendingIntro()
    const result = await acceptIntro(intro.id, rec.id)
    expect(result).toEqual({ matchId: existing.id })
    expect(await sql`select id from matches`).toHaveLength(1)
    expect((await introRow(intro.id)).match_id).toBe(existing.id)
    expect(seedIcebreakers).not.toHaveBeenCalled()
  })

  it('returns match_failed and reverts the claim on a non-23505 matches insert error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const intro = await pendingIntro()
    const cleanup = await failWritesTo('matches', 'INSERT')
    try {
      expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'match_failed' })
    } finally {
      await cleanup()
      errSpy.mockRestore()
    }
    // Back to pending so the intro stays retryable.
    expect((await introRow(intro.id)).intro_status).toBe('pending')
    expect(await sql`select id from messages`).toHaveLength(0)
  })

  it('returns buyer_unavailable and creates no match when the buyer is soft-deleted', async () => {
    await sql`update users set deleted_at = now() where id = ${buyer.id}`
    const intro = await pendingIntro()
    expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'buyer_unavailable' })
    // The intro leaves 'pending' the same way a decline does, so it never resurfaces.
    expect((await introRow(intro.id)).intro_status).toBe('dismissed')
    expect(await sql`select id from matches`).toHaveLength(0)
    expect(await sql`select id from messages`).toHaveLength(0)
  })

  it('returns buyer_unavailable when the buyer is banned', async () => {
    await sql`update users set banned_at = now() where id = ${buyer.id}`
    const intro = await pendingIntro()
    expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'buyer_unavailable' })
    expect(await sql`select id from matches`).toHaveLength(0)
  })

  it('returns buyer_unavailable when the buyer row is gone', async () => {
    const intro = await pendingIntro()
    await forceDeleteUser(buyer.id)
    expect(await acceptIntro(intro.id, rec.id)).toEqual({ error: 'buyer_unavailable' })
    expect((await introRow(intro.id)).intro_status).toBe('dismissed')
  })
})

describe('dismissIntro', () => {
  it('returns not_found when the caller is not the recipient', async () => {
    const intro = await pendingIntro()
    const other = await createUser()
    expect(await dismissIntro(intro.id, other.id)).toEqual({ error: 'not_found' })
  })

  it('returns not_found for a malformed (non-uuid) id', async () => {
    expect(await dismissIntro('nope', rec.id)).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    const intro = await pendingIntro({ intro_status: 'dismissed' })
    expect(await dismissIntro(intro.id, rec.id)).toEqual({ error: 'already_handled' })
  })

  it('dismisses a fresh pending intro', async () => {
    const intro = await pendingIntro()
    expect(await dismissIntro(intro.id, rec.id)).toEqual({ ok: true })
    expect((await introRow(intro.id)).intro_status).toBe('dismissed')
  })
})

describe('listPendingIntros', () => {
  it('maps pending intros, picking the lowest-position photo as primary', async () => {
    await createPhoto(buyer.id, 2, { url: 'url-position-2' })
    await createPhoto(buyer.id, 0, { url: 'url-position-0' })
    await createPhoto(buyer.id, 1, { url: 'url-position-1' })
    const intro = await pendingIntro({ note: 'hi there', created_at: '2026-01-01T00:00:00Z' })

    expect(await listPendingIntros(rec.id)).toEqual([{
      id: intro.id,
      buyer: { id: buyer.id, name: 'Ali', photo: 'url-position-0' },
      emoji: '🌹',
      note: 'hi there',
      createdAt: '2026-01-01T00:00:00.000Z',
    }])
  })

  it('returns photo null when the buyer has no photos, and only pending discovery intros, newest first', async () => {
    const older = await pendingIntro({ created_at: '2026-01-01T00:00:00Z' })
    const newer = await pendingIntro({ created_at: '2026-01-02T00:00:00Z' })
    await pendingIntro({ intro_status: 'accepted' })
    await pendingIntro({ context: 'chat', intro_status: null })
    await createGiftTx(rec.id, buyer.id, { intro_status: 'pending' }) // someone else's inbox

    const result = await listPendingIntros(rec.id)
    expect(result.map((r) => r.id)).toEqual([newer.id, older.id])
    expect(result[0].buyer.photo).toBeNull()
    expect(result[0].note).toBeNull()
  })

  it('drops intros whose buyer is soft-deleted or banned', async () => {
    const gone = await createUser({ name: 'Gone', deleted_at: '2026-01-02T00:00:00Z' })
    const bad = await createUser({ name: 'Bad', banned_at: '2026-01-02T00:00:00Z' })
    await createGiftTx(gone.id, rec.id, { status: 'sent', intro_status: 'pending' })
    await createGiftTx(bad.id, rec.id, { status: 'sent', intro_status: 'pending' })
    await createPhoto(buyer.id, 0, { url: 'p0' })
    const alive = await pendingIntro({ note: 'hey', created_at: '2026-01-01T00:00:00Z' })

    expect(await listPendingIntros(rec.id)).toEqual([{
      id: alive.id,
      buyer: { id: buyer.id, name: 'Ali', photo: 'p0' },
      emoji: '🌹',
      note: 'hey',
      createdAt: '2026-01-01T00:00:00.000Z',
    }])
  })
})
