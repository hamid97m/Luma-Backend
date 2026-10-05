import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { sendGiftToUser, refundGift, notifyGiftIntro, notifyNewMessage, notifyPaymentChannel } from '../src/bot.js'
import { handleGiftPaid, validatePreCheckout } from '../src/gifts/service.js'
import { en } from '../src/i18n/en.js'
import { fa } from '../src/i18n/fa.js'

const CLAIM_TX = {
  id: 'tx1', buyer_id: 'b', recipient_id: 'r', context: 'chat', match_id: 'm1', gift_id: 'g', gift_emoji: '🌹', note: null,
}
const DISCOVERY_TX = {
  id: 'tx1', buyer_id: 'b', recipient_id: 'r', context: 'discovery', match_id: null, gift_id: 'g', gift_emoji: '🌹', note: null,
}

/** Claim step: update -> eq -> eq -> select -> maybeSingle, returning `data`. */
function claimStep(data: any) {
  return { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data }) }) }) }) }) }
}
/** Simple lookup step: select -> eq -> single/maybeSingle, returning `data`. */
function lookupStep(data: any) {
  const leaf = { single: () => ({ data }), maybeSingle: () => ({ data }) }
  return { select: () => ({ eq: () => leaf }) }
}
/** update() spy step: captures the payload passed to update(), then eq() resolves. */
function updateSpyStep(spy: (payload: any) => void) {
  return { update: (payload: any) => { spy(payload); return { eq: () => ({ error: null }) } } }
}
/** insert() spy step: captures the payload passed to insert(). */
function insertSpyStep(spy: (payload: any) => void) {
  return { insert: (payload: any) => { spy(payload); return { error: null } } }
}

// Helper to script db.from() calls in order. Each entry returns a thenable/awaited shape
// matching the query chain used by handleGiftPaid (update→select→maybeSingle, select→single, insert, update).
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

describe('handleGiftPaid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the gift and records a chat message on success', async () => {
    const sentUpdates: any[] = []
    const inserts: any[] = []
    scriptDb([
      claimStep(CLAIM_TX),                                   // 1. claim pending tx
      lookupStep({ telegram_id: 999, name: 'Sara', locale: 'en' }), // 2. recipient lookup
      lookupStep({ name: 'Ali' }),                            // 3. buyer lookup
      updateSpyStep((p) => sentUpdates.push(p)),              // 4. mark sent
      insertSpyStep((p) => inserts.push(p)),                  // 5. insert gift message
    ])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)

    expect(sendGiftToUser).toHaveBeenCalledWith(999, 'g', undefined)
    expect(refundGift).not.toHaveBeenCalled()

    // the chat DM is worded in the recipient's language and carries their locale
    expect(notifyNewMessage).toHaveBeenCalledWith(999, 'Ali', en.gifts.sentYouGift('🌹'), null, undefined, 'en')

    expect(sentUpdates).toHaveLength(1)
    expect(sentUpdates[0]).toMatchObject({ status: 'sent' })

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      type: 'gift', gift_transaction_id: 'tx1', sender_id: 'b', match_id: 'm1', body: null,
    })

    // posts the ops notice with buyer/recipient/gift/amount/charge on delivery
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(notifyPaymentChannel).mock.calls[0][0]
    expect(notice).toContain('🎁 Gift sent')
    expect(notice).toContain('Ali')
    expect(notice).toContain('Sara')
    expect(notice).toContain('🌹')
    expect(notice).toContain('75 ⭐')
    expect(notice).toContain('charge_1')
  })

  it('refunds when sendGift fails', async () => {
    vi.mocked(sendGiftToUser).mockRejectedValueOnce(new Error('insufficient balance'))
    const refundUpdates: any[] = []
    scriptDb([
      claimStep(CLAIM_TX),
      lookupStep({ telegram_id: 999, name: 'Sara' }),
      lookupStep({ name: 'Ali' }),
      updateSpyStep((p) => refundUpdates.push(p)), // refunded status update
    ])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)

    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
    expect(refundUpdates).toHaveLength(1)
    expect(refundUpdates[0]).toMatchObject({ status: 'refunded' })
  })

  it('marks the tx send_failed (not refunded) when refundGift itself throws', async () => {
    vi.mocked(sendGiftToUser).mockRejectedValueOnce(new Error('insufficient balance'))
    vi.mocked(refundGift).mockRejectedValueOnce(new Error('telegram refund error'))
    const updates: any[] = []
    scriptDb([
      claimStep(CLAIM_TX),
      lookupStep({ telegram_id: 999, name: 'Sara' }),
      lookupStep({ name: 'Ali' }),
      updateSpyStep((p) => updates.push(p)), // send_failed status update
    ])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)

    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ status: 'send_failed' })
  })

  it('is idempotent when the tx is not pending (replay)', async () => {
    scriptDb([claimStep(null)])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)
    expect(sendGiftToUser).not.toHaveBeenCalled()
  })

  it('sets intro_status pending and notifies via notifyGiftIntro for a discovery gift', async () => {
    const introUpdates: any[] = []
    scriptDb([
      claimStep(DISCOVERY_TX),                          // 1. claim pending tx
      lookupStep({ telegram_id: 999, name: 'Sara', locale: 'ar' }), // 2. recipient lookup
      lookupStep({ name: 'Ali' }),                      // 3. buyer lookup
      updateSpyStep(() => {}),                          // 4. mark sent
      updateSpyStep((p) => introUpdates.push(p)),       // 5. set intro_status
    ])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)

    expect(sendGiftToUser).toHaveBeenCalledWith(999, 'g', undefined)
    expect(introUpdates).toHaveLength(1)
    expect(introUpdates[0]).toMatchObject({ intro_status: 'pending' })
    expect(notifyGiftIntro).toHaveBeenCalledWith(999, 'Ali', '🌹', 'ar')
  })

  it('uses the recipient\'s fallback name and null locale when the row has none', async () => {
    scriptDb([
      claimStep(DISCOVERY_TX),
      lookupStep({ telegram_id: 999, name: 'Sara', locale: null }),
      lookupStep(null), // buyer row gone → fallback name
      updateSpyStep(() => {}),
      updateSpyStep(() => {}),
    ])
    await handleGiftPaid('tx1', 'charge_1', 111, 75)
    expect(notifyGiftIntro).toHaveBeenCalledWith(999, fa.notify.fallbackName, '🌹', null)
  })
})

describe('validatePreCheckout', () => {
  beforeEach(() => vi.clearAllMocks())
  const PENDING = { status: 'pending_payment', charged_stars: 75, gift_id: 'g', buyer_id: 'b' }

  it('rejects an unknown tx in Persian without a buyer lookup', async () => {
    scriptDb([lookupStep(null)])
    expect(await validatePreCheckout('tx1', 75, 'XTR')).toEqual({ ok: false, reason: fa.gifts.checkoutUnavailable })
    expect(db.from).toHaveBeenCalledTimes(1)
  })
  it('rejects an already-processed tx in the buyer\'s language', async () => {
    scriptDb([lookupStep({ ...PENDING, status: 'paid' }), lookupStep({ locale: 'en' })])
    expect(await validatePreCheckout('tx1', 75, 'XTR')).toEqual({ ok: false, reason: en.gifts.checkoutAlreadyProcessed })
  })
  it('rejects a price mismatch in the buyer\'s language', async () => {
    scriptDb([lookupStep(PENDING), lookupStep({ locale: 'en' })])
    expect(await validatePreCheckout('tx1', 10, 'XTR')).toEqual({ ok: false, reason: en.gifts.checkoutPriceMismatch })
  })
})
