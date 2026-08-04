import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
}))
import { db } from '../src/db.js'
import { sendGiftToUser, refundGift } from '../src/bot.js'
import { handleGiftPaid } from '../src/gifts/service.js'

// Helper to script db.from() calls in order. Each entry returns a thenable/awaited shape
// matching the query chain used by handleGiftPaid (update→select→maybeSingle, select→single, insert, update).
function scriptDb(steps: any[]) {
  let i = 0
  vi.mocked(db.from).mockImplementation(() => steps[i++] as any)
}

describe('handleGiftPaid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the gift and records a chat message on success', async () => {
    scriptDb([
      // 1. claim pending tx
      { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data: {
        id: 'tx1', buyer_id: 'b', recipient_id: 'r', context: 'chat', match_id: 'm1', gift_id: 'g', gift_emoji: '🌹', note: null,
      } }) }) }) }) }) },
      // 2. recipient lookup
      { select: () => ({ eq: () => ({ single: () => ({ data: { telegram_id: 999, name: 'Sara' } }) }) }) },
      // 3. buyer lookup
      { select: () => ({ eq: () => ({ single: () => ({ data: { name: 'Ali' } }) }) }) },
      // 4. mark sent
      { update: () => ({ eq: () => ({}) }) },
      // 5. insert gift message
      { insert: () => ({}) },
    ])
    await handleGiftPaid('tx1', 'charge_1', 111)
    expect(sendGiftToUser).toHaveBeenCalledWith(999, 'g', undefined)
    expect(refundGift).not.toHaveBeenCalled()
  })

  it('refunds when sendGift fails', async () => {
    vi.mocked(sendGiftToUser).mockRejectedValueOnce(new Error('insufficient balance'))
    scriptDb([
      { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data: {
        id: 'tx1', buyer_id: 'b', recipient_id: 'r', context: 'chat', match_id: 'm1', gift_id: 'g', gift_emoji: '🌹', note: null,
      } }) }) }) }) }) },
      { select: () => ({ eq: () => ({ single: () => ({ data: { telegram_id: 999, name: 'Sara' } }) }) }) },
      { select: () => ({ eq: () => ({ single: () => ({ data: { name: 'Ali' } }) }) }) },
      { update: () => ({ eq: () => ({}) }) }, // refunded status update
    ])
    await handleGiftPaid('tx1', 'charge_1', 111)
    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
  })

  it('is idempotent when the tx is not pending (replay)', async () => {
    scriptDb([
      { update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }) }) },
    ])
    await handleGiftPaid('tx1', 'charge_1', 111)
    expect(sendGiftToUser).not.toHaveBeenCalled()
  })
})
