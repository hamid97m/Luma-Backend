import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { acceptIntro, dismissIntro, listPendingIntros } from '../src/gifts/service.js'

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
/** Lookup step: select -> eq -> maybeSingle, returning `data`. (resolveClaimMiss's re-select) */
function lookupMaybeSingleStep(data: any) {
  return { select: () => ({ eq: () => ({ maybeSingle: () => ({ data }) }) }) }
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
      matchesInsertStep({ id: 'match1' }, null, (p) => matchInserts.push(p)),                          // 2. matches insert
      updateSpyStep((p) => txUpdates.push(p)),                                                         // 3. set match_id
      insertSpyStep((p) => msgInserts.push(p)),                                                        // 4. seed gift message
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
  })

  it('reuses the existing match on a 23505 unique-constraint conflict', async () => {
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }), // 1. atomic claim
      matchesInsertStep(null, { code: '23505' }),                        // 2. matches insert (conflict)
      matchesLookupStep({ id: 'existing-match' }),                       // 3. re-select existing match
      updateSpyStep(() => {}),                                           // 4. set match_id
      insertSpyStep(() => {}),                                           // 5. seed gift message
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ matchId: 'existing-match' })
  })

  it('returns match_failed if the 23505 re-select finds nothing', async () => {
    scriptDb([
      claimStep({ id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1' }), // 1. atomic claim
      matchesInsertStep(null, { code: '23505' }),                        // 2. matches insert (conflict)
      matchesLookupStep(null),                                           // 3. re-select finds nothing
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'match_failed' })
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
})
