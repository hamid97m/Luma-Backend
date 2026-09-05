import { describe, it, expect } from 'vitest'
import { formatPremiumPaidNotice, formatGiftPaidNotice } from '../src/payments/paymentNotify.js'

describe('formatPremiumPaidNotice', () => {
  it('includes buyer, duration, amount, charge and time', () => {
    const text = formatPremiumPaidNotice({
      buyerName: 'Ali', durationDays: 30, amountStars: 100, chargeId: 'ch_1', at: '2026-09-05T10:00:00.000Z',
    })
    expect(text).toContain('💎 Premium purchased')
    expect(text).toContain('Buyer: Ali')
    expect(text).toContain('Duration: 30 days')
    expect(text).toContain('Amount: 100 ⭐')
    expect(text).toContain('Charge: ch_1')
    expect(text).toContain('Time: 2026-09-05T10:00:00.000Z')
  })

  it('falls back to "unknown" when the buyer name is missing', () => {
    const text = formatPremiumPaidNotice({
      buyerName: null, durationDays: 7, amountStars: 50, chargeId: 'ch_2', at: 'now',
    })
    expect(text).toContain('Buyer: unknown')
  })
})

describe('formatGiftPaidNotice', () => {
  it('includes buyer, recipient, gift, amount, charge and time', () => {
    const text = formatGiftPaidNotice({
      buyerName: 'Ali', recipientName: 'Sara', giftEmoji: '🌹', amountStars: 75, chargeId: 'ch_3', at: 'now',
    })
    expect(text).toContain('🎁 Gift sent')
    expect(text).toContain('Buyer: Ali')
    expect(text).toContain('Recipient: Sara')
    expect(text).toContain('Gift: 🌹')
    expect(text).toContain('Amount: 75 ⭐')
    expect(text).toContain('Charge: ch_3')
  })

  it('falls back to defaults when names/emoji are missing', () => {
    const text = formatGiftPaidNotice({
      buyerName: null, recipientName: null, giftEmoji: null, amountStars: 10, chargeId: 'ch_4', at: 'now',
    })
    expect(text).toContain('Buyer: unknown')
    expect(text).toContain('Recipient: unknown')
    expect(text).toContain('Gift: 🎁')
  })
})
