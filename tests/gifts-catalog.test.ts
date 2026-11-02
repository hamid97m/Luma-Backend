import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn(), createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn(), notifyNewMessage: vi.fn(), notifyGiftIntro: vi.fn(),
}))
import { getGiftCatalog } from '../src/bot.js'
import { getCatalogForBuyer } from '../src/gifts/service.js'
import { resetDb, insertRow, sql } from './helpers/db.js'

describe('getCatalogForBuyer', () => {
  beforeEach(async () => {
    await resetDb()
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
  })

  it('excludes gifts with globally sold-out or exhausted bot allocation, includes the rest with marked-up pricing', async () => {
    // Fresh install: gift_config.markup_percent defaults to 33, no overrides.
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

  it('applies the configured markup and per-gift price overrides', async () => {
    await sql`update gift_config set markup_percent = 0 where id = true`
    await insertRow('gift_price_overrides', { gift_id: 'regular', charged_stars: 25 })

    const catalog = await getCatalogForBuyer()
    expect(catalog.find((g) => g.giftId === 'regular')!.chargedStars).toBe(25)
    expect(catalog.find((g) => g.giftId === 'available_limited')!.chargedStars).toBe(200)
  })

  it('falls back to the 33% default markup when the config row is missing', async () => {
    await sql`delete from gift_config`
    const catalog = await getCatalogForBuyer()
    expect(catalog.find((g) => g.giftId === 'regular')!.chargedStars).toBe(20)
  })
})
