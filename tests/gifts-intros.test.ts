import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))
import { db } from '../src/db.js'
import { acceptIntro, dismissIntro, listPendingIntros } from '../src/gifts/service.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'

/**
 * Claim step: update -> eq -> eq -> eq -> select -> maybeSingle, returning `data`.
 * Mirrors the atomic claim used by acceptIntro/dismissIntro
 * (`.eq('id', ...).eq('recipient_id', ...).eq('intro_status', 'pending')`).
 * Captures the update() payload.
 */
function claimStep(data: any, spy?: (payload: any) => void) {
  return {
    update: (payload: any) => {
      spy?.(payload)
      return { eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data }) }) }) }) }) }
    },
  }
}
/** Lookup step: select -> eq -> maybeSingle, returning `data`. (resolveClaimMiss's re-select, acceptIntro's buyer availability check) */
function lookupMaybeSingleStep(data: any) {
  return { select: () => ({ eq: () => ({ maybeSingle: () => ({ data }) }) }) }
}
/** Buyer availability step for acceptIntro: an alive (not deleted/banned) buyer. */
function aliveBuyerStep() {
  return lookupMaybeSingleStep({ deleted_at: null, banned_at: null })
}
/** matches insert step: insert -> select -> maybeSingle, returning `{ data, error }`. Captures the insert payload. */
function matchesInsertStep(data: any, error: any, spy?: (payload: any) => void) {
  return { insert: (payload: any) => { spy?.(payload); return { select: () => ({ maybeSingle: () => ({ data, error }) }) } } }
}
/** matches lookup step (23505 conflict path): select -> eq -> eq -> single, returning `data`. */
function matchesLookupStep(data: any) {
  return { select: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data }) }) }) }) }
}
/** update() spy step: captures the payload passed to update(), then eq() resolves. */
function updateSpyStep(spy: (payload: any) => void) {
  return { update: (payload: any) => { spy(payload); return { eq: () => ({ error: null }) } } }
}
/** insert() spy step: captures the payload passed to insert(). */
function insertSpyStep(spy: (payload: any) => void) {
  return { insert: (payload: any) => { spy(payload); return { error: null } } }
}
/** listPendingIntros step: select -> eq -> eq -> eq -> order, returning `{ data }`. */
function listStep(data: any) {
  return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ data }) }) }) }) }) }
}

// Helper to script db.from() calls in order.
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

describe('acceptIntro', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_found when the caller is not the recipient', async () => {
    scriptDb([
      claimStep(null),                                                          // 1. claim attempt fails (recipient_id filter)
      lookupMaybeSingleStep({ recipient_id: 'rec1', intro_status: 'pending' }),  // 2. resolve miss: tx belongs to someone else
    ])
    const result = await acceptIntro('tx1', 'someone-else')
    expect(result).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    scriptDb([
      claimStep(null),                                                          // 1. claim attempt fails (intro_status filter)
      lookupMaybeSingleStep({ recipient_id: 'rec1', intro_status: 'accepted' }), // 2. resolve miss: owned but not pending
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'already_handled' })
  })

  it('returns already_handled on a second accept (claim loses the race)', async () => {
    // Simulates a double-tap/retry: the first call already flipped intro_status to 'accepted',
    // so this second call's atomic claim matches nothing, and the follow-up lookup finds a
    // non-pending row still owned by the same recipient.
    scriptDb([
      claimStep(null),
      lookupMaybeSingleStep({ recipient_id: 'rec1', intro_status: 'accepted' }),
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'already_handled' })
  })

  it('creates a match and seeds a gift message for a fresh pending intro', async () => {
    const claimUpdates: any[] = []
    const matchInserts: any[] = []
    const txUpdates: any[] = []
    const msgInserts: any[] = []
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }, (p) => claimUpdates.push(p)), // 1. atomic claim
      aliveBuyerStep(),                                                                                // 2. buyer availability check
      matchesInsertStep({ id: 'match1' }, null, (p) => matchInserts.push(p)),                          // 3. matches insert
      updateSpyStep((p) => txUpdates.push(p)),                                                         // 4. set match_id
      insertSpyStep((p) => msgInserts.push(p)),                                                        // 5. seed gift message
    ])
    const result = await acceptIntro('tx1', 'rec1')

    expect(result).toEqual({ matchId: 'match1' })

    expect(claimUpdates).toHaveLength(1)
    expect(claimUpdates[0]).toEqual({ intro_status: 'accepted' })

    expect(matchInserts).toHaveLength(1)
    // buyer1 < rec1 lexicographically, so pair order stays (buyer1, rec1).
    expect(matchInserts[0]).toEqual({ user1_id: 'buyer1', user2_id: 'rec1' })

    expect(txUpdates).toHaveLength(1)
    expect(txUpdates[0]).toEqual({ match_id: 'match1' })

    expect(msgInserts).toHaveLength(1)
    expect(msgInserts[0]).toMatchObject({
      match_id: 'match1', sender_id: 'buyer1', type: 'gift', gift_transaction_id: 'tx1', body: null,
    })

    // Icebreakers follow the gift, buyer's first.
    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith('match1', ['buyer1', 'rec1'])
  })

  it('seeds icebreakers only after the gift message is inserted', async () => {
    const order: string[] = []
    vi.mocked(seedIcebreakers).mockImplementationOnce(async () => { order.push('seed') })
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }),
      aliveBuyerStep(),
      matchesInsertStep({ id: 'match1' }, null),
      updateSpyStep(() => {}),
      insertSpyStep(() => order.push('gift')),
    ])
    await acceptIntro('tx1', 'rec1')
    expect(order).toEqual(['gift', 'seed'])
  })

  it('reuses the existing match on a 23505 unique-constraint conflict', async () => {
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }), // 1. atomic claim
      aliveBuyerStep(),                                                  // 2. buyer availability check
      matchesInsertStep(null, { code: '23505' }),                        // 3. matches insert (conflict)
      matchesLookupStep({ id: 'existing-match' }),                       // 4. re-select existing match
      updateSpyStep(() => {}),                                           // 5. set match_id
      insertSpyStep(() => {}),                                           // 6. seed gift message
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ matchId: 'existing-match' })
    expect(seedIcebreakers).not.toHaveBeenCalled()
  })

  it('returns match_failed and reverts the claim if the 23505 re-select finds nothing', async () => {
    const revertUpdates: any[] = []
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }), // 1. atomic claim
      aliveBuyerStep(),                                                  // 2. buyer availability check
      matchesInsertStep(null, { code: '23505' }),                        // 3. matches insert (conflict)
      matchesLookupStep(null),                                           // 4. re-select finds nothing
      updateSpyStep((p) => revertUpdates.push(p)),                       // 5. revert claim back to pending
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'match_failed' })
    expect(revertUpdates).toHaveLength(1)
    expect(revertUpdates[0]).toEqual({ intro_status: 'pending' })
  })

  it('returns match_failed and reverts the claim on a non-23505 matches insert error', async () => {
    const revertUpdates: any[] = []
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }), // 1. atomic claim
      aliveBuyerStep(),                                                   // 2. buyer availability check
      matchesInsertStep(null, { code: '23000', message: 'boom' }),        // 3. matches insert (unrelated failure)
      updateSpyStep((p) => revertUpdates.push(p)),                        // 4. revert claim back to pending
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'match_failed' })
    expect(revertUpdates).toHaveLength(1)
    expect(revertUpdates[0]).toEqual({ intro_status: 'pending' })
  })

  it('returns buyer_unavailable and creates no match when the buyer is soft-deleted', async () => {
    const retireUpdates: any[] = []
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }),          // 1. atomic claim
      lookupMaybeSingleStep({ deleted_at: '2026-09-01T00:00:00Z', banned_at: null }), // 2. buyer is deleted
      updateSpyStep((p) => retireUpdates.push(p)),                                  // 3. retire intro like a decline
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'buyer_unavailable' })
    // The intro leaves 'pending' the same way a decline does, so it never resurfaces.
    expect(retireUpdates).toHaveLength(1)
    expect(retireUpdates[0]).toEqual({ intro_status: 'dismissed' })
    // No matches insert / gift-message seed happened: only the 3 scripted db calls ran.
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(3)
  })

  it('returns buyer_unavailable when the buyer is banned', async () => {
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }),          // 1. atomic claim
      lookupMaybeSingleStep({ deleted_at: null, banned_at: '2026-09-01T00:00:00Z' }), // 2. buyer is banned
      updateSpyStep(() => {}),                                                      // 3. retire intro
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'buyer_unavailable' })
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(3)
  })
})

describe('dismissIntro', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_found when the caller is not the recipient', async () => {
    scriptDb([
      claimStep(null),                                                          // 1. claim attempt fails
      lookupMaybeSingleStep({ recipient_id: 'rec1', intro_status: 'pending' }),  // 2. resolve miss
    ])
    const result = await dismissIntro('tx1', 'someone-else')
    expect(result).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    scriptDb([
      claimStep(null),
      lookupMaybeSingleStep({ recipient_id: 'rec1', intro_status: 'dismissed' }),
    ])
    const result = await dismissIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'already_handled' })
  })

  it('dismisses a fresh pending intro', async () => {
    const claimUpdates: any[] = []
    scriptDb([
      claimStep({ id: 'tx1' }, (p) => claimUpdates.push(p)), // 1. atomic claim
    ])
    const result = await dismissIntro('tx1', 'rec1')
    expect(result).toEqual({ ok: true })
    expect(claimUpdates).toHaveLength(1)
    expect(claimUpdates[0]).toEqual({ intro_status: 'dismissed' })
  })
})

describe('listPendingIntros', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps pending intros, picking the lowest-position photo as primary', async () => {
    scriptDb([
      listStep([{
        id: 'intro1',
        note: 'hi there',
        gift_emoji: '🌹',
        created_at: '2026-01-01T00:00:00Z',
        buyer: {
          id: 'buyer1',
          name: 'Ali',
          deleted_at: null,
          banned_at: null,
          user_photos: [
            { url: 'url-position-2', position: 2 },
            { url: 'url-position-0', position: 0 },
            { url: 'url-position-1', position: 1 },
          ],
        },
      }]),
    ])
    const result = await listPendingIntros('rec1')
    expect(result).toEqual([{
      id: 'intro1',
      buyer: { id: 'buyer1', name: 'Ali', photo: 'url-position-0' },
      emoji: '🌹',
      note: 'hi there',
      createdAt: '2026-01-01T00:00:00Z',
    }])
  })

  it('drops intros whose buyer is soft-deleted or banned', async () => {
    scriptDb([
      listStep([
        {
          id: 'intro-deleted',
          note: null,
          gift_emoji: '🎁',
          created_at: '2026-01-03T00:00:00Z',
          buyer: { id: 'buyer-deleted', name: 'Gone', deleted_at: '2026-01-02T00:00:00Z', banned_at: null, user_photos: [] },
        },
        {
          id: 'intro-banned',
          note: null,
          gift_emoji: '🎁',
          created_at: '2026-01-02T12:00:00Z',
          buyer: { id: 'buyer-banned', name: 'Bad', deleted_at: null, banned_at: '2026-01-02T00:00:00Z', user_photos: [] },
        },
        {
          id: 'intro-alive',
          note: 'hey',
          gift_emoji: '🌹',
          created_at: '2026-01-01T00:00:00Z',
          buyer: { id: 'buyer-alive', name: 'Sara', deleted_at: null, banned_at: null, user_photos: [{ url: 'p0', position: 0 }] },
        },
      ]),
    ])
    const result = await listPendingIntros('rec1')
    expect(result).toEqual([{
      id: 'intro-alive',
      buyer: { id: 'buyer-alive', name: 'Sara', photo: 'p0' },
      emoji: '🌹',
      note: 'hey',
      createdAt: '2026-01-01T00:00:00Z',
    }])
  })
})
