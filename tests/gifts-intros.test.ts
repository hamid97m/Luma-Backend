import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { acceptIntro, dismissIntro } from '../src/gifts/service.js'

const PENDING_TX = {
  id: 'tx1', buyer_id: 'buyer1', recipient_id: 'rec1', intro_status: 'pending',
}

/** Lookup step: select -> eq -> maybeSingle, returning `data`. */
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

// Helper to script db.from() calls in order.
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

describe('acceptIntro', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_found when the caller is not the recipient', async () => {
    scriptDb([lookupMaybeSingleStep(PENDING_TX)]) // 1. tx lookup
    const result = await acceptIntro('tx1', 'someone-else')
    expect(result).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    scriptDb([lookupMaybeSingleStep({ ...PENDING_TX, intro_status: 'accepted' })]) // 1. tx lookup
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'already_handled' })
  })

  it('creates a match and seeds a gift message for a fresh pending intro', async () => {
    const matchInserts: any[] = []
    const txUpdates: any[] = []
    const msgInserts: any[] = []
    scriptDb([
      lookupMaybeSingleStep(PENDING_TX),                                  // 1. tx lookup
      matchesInsertStep({ id: 'match1' }, null, (p) => matchInserts.push(p)), // 2. matches insert
      updateSpyStep((p) => txUpdates.push(p)),                            // 3. mark tx accepted + match_id
      insertSpyStep((p) => msgInserts.push(p)),                           // 4. seed gift message
    ])
    const result = await acceptIntro('tx1', 'rec1')

    expect(result).toEqual({ matchId: 'match1' })

    expect(matchInserts).toHaveLength(1)
    // buyer1 < rec1 lexicographically, so pair order stays (buyer1, rec1).
    expect(matchInserts[0]).toEqual({ user1_id: 'buyer1', user2_id: 'rec1' })

    expect(txUpdates).toHaveLength(1)
    expect(txUpdates[0]).toMatchObject({ intro_status: 'accepted', match_id: 'match1' })

    expect(msgInserts).toHaveLength(1)
    expect(msgInserts[0]).toMatchObject({
      match_id: 'match1', sender_id: 'buyer1', type: 'gift', gift_transaction_id: 'tx1', body: null,
    })
  })

  it('reuses the existing match on a 23505 unique-constraint conflict', async () => {
    scriptDb([
      lookupMaybeSingleStep(PENDING_TX),                                              // 1. tx lookup
      matchesInsertStep(null, { code: '23505' }),                                     // 2. matches insert (conflict)
      matchesLookupStep({ id: 'existing-match' }),                                    // 3. re-select existing match
      updateSpyStep(() => {}),                                                        // 4. mark tx accepted
      insertSpyStep(() => {}),                                                        // 5. seed gift message
    ])
    const result = await acceptIntro('tx1', 'rec1')
    expect(result).toEqual({ matchId: 'existing-match' })
  })
})

describe('dismissIntro', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_found when the caller is not the recipient', async () => {
    scriptDb([lookupMaybeSingleStep(PENDING_TX)]) // 1. tx lookup
    const result = await dismissIntro('tx1', 'someone-else')
    expect(result).toEqual({ error: 'not_found' })
  })

  it('returns already_handled when the intro is not pending', async () => {
    scriptDb([lookupMaybeSingleStep({ ...PENDING_TX, intro_status: 'dismissed' })]) // 1. tx lookup
    const result = await dismissIntro('tx1', 'rec1')
    expect(result).toEqual({ error: 'already_handled' })
  })

  it('dismisses a fresh pending intro', async () => {
    const updates: any[] = []
    scriptDb([
      lookupMaybeSingleStep(PENDING_TX),        // 1. tx lookup
      updateSpyStep((p) => updates.push(p)),    // 2. set intro_status dismissed
    ])
    const result = await dismissIntro('tx1', 'rec1')
    expect(result).toEqual({ ok: true })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ intro_status: 'dismissed' })
  })
})
