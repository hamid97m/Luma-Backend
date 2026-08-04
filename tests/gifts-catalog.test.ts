import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn(), notifyNewMessage: vi.fn(), notifyGiftIntro: vi.fn(),
}))
import { db } from '../src/db.js'
import { getGiftCatalog } from '../src/bot.js'
import { getCatalogForBuyer } from '../src/gifts/service.js'

describe('getCatalogForBuyer', () => {
  it('excludes gifts with globally sold-out or exhausted bot allocation, includes the rest with marked-up pricing', async () => {
    vi.mocked(getGiftCatalog).mockResolvedValue([
      // Regular gift: no remaining_count/personal_remaining_count at all -> included.
      { id: 'regular', sticker: { emoji: '🌹' }, star_count: 15 } as any,
      // Limited, globally sold out -> excluded.
      { id: 'sold_out_global', sticker: { emoji: '🎁' }, star_count: 50, remaining_count: 0 } as any,
      // Limited, global stock left but bot's own allocation exhausted -> excluded.
      { id: 'sold_out_personal', sticker: { emoji: '💎' }, star_count: 100, remaining_count: 10, personal_remaining_count: 0 } as any,
      // Limited, both counts positive -> included.
      { id: 'available_limited', sticker: { emoji: '🚀' }, star_count: 200, remaining_count: 5, personal_remaining_count: 3 } as any,
    ])

    // db.from is called twice by getCatalogForBuyer: once for gift_config (markup), once for gift_price_overrides.
    let call = 0
    vi.mocked(db.from).mockImplementation((): any => {
      call += 1
      if (call === 1) {
        // pricingConfig(): select('markup_percent').eq('id', true).single()
        return { select: () => ({ eq: () => ({ single: () => ({ data: { markup_percent: 33 } }) }) }) }
      }
      // overrides: select('gift_id, charged_stars')
      return { select: () => ({ data: [] }) }
    })

    const catalog = await getCatalogForBuyer()

    const ids = catalog.map((g) => g.giftId)
    expect(ids).toContain('regular')
    expect(ids).toContain('available_limited')
    expect(ids).not.toContain('sold_out_global')
    expect(ids).not.toContain('sold_out_personal')
    expect(catalog).toHaveLength(2)

    const regular = catalog.find((g) => g.giftId === 'regular')!
    expect(regular.emoji).toBe('🌹')
    expect(regular.chargedStars).toBe(20) // 15 * 1.33 = 19.95 -> ceil -> 20

    const limited = catalog.find((g) => g.giftId === 'available_limited')!
    expect(limited.emoji).toBe('🚀')
    expect(limited.chargedStars).toBe(266) // 200 * 1.33 = 266
  })
})
