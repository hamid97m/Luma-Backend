import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/bot.js', () => ({
  getGiftCatalog: vi.fn().mockResolvedValue([{ id: 'g', sticker: { emoji: '🌹' }, star_count: 15 }]),
  createGiftInvoiceLink: vi.fn(), sendGiftToUser: vi.fn(),
  refundGift: vi.fn().mockResolvedValue(undefined), notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
}))
import { sendGiftToUser, refundGift, notifyGiftIntro, notifyNewMessage, notifyPaymentChannel } from '../src/bot.js'
import { handleGiftPaid, validatePreCheckout } from '../src/gifts/service.js'
import { en } from '../src/i18n/en.js'
import { fa } from '../src/i18n/fa.js'
import { resetDb, createUser, createMatch, sql } from './helpers/db.js'
import { createGiftTx, failWritesTo, forceDeleteUser } from './helpers/gifts-referrals.js'

let buyer: Record<string, any>
let recipient: Record<string, any>

async function txRow(id: string) {
  const [row] = await sql`select * from gift_transactions where id = ${id}`
  return row
}

beforeEach(async () => {
  await resetDb()
  vi.mocked(sendGiftToUser).mockResolvedValue(undefined as any)
  vi.mocked(refundGift).mockResolvedValue(undefined as any)
  buyer = await createUser({ name: 'Ali' })
  recipient = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', locale: 'en' })
})

describe('handleGiftPaid', () => {
  async function chatTx() {
    const match = await createMatch(buyer.id, recipient.id)
    return createGiftTx(buyer.id, recipient.id, { context: 'chat', match_id: match.id })
  }

  it('sends the gift and records a chat message on success', async () => {
    const tx = await chatTx()
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)

    expect(sendGiftToUser).toHaveBeenCalledWith(recipient.telegram_id, 'g', undefined)
    expect(refundGift).not.toHaveBeenCalled()

    // the chat DM is worded in the recipient's language and carries their locale
    expect(notifyNewMessage).toHaveBeenCalledWith(recipient.telegram_id, 'Ali', en.gifts.sentYouGift('🌹'), null, undefined, 'en')

    const row = await txRow(tx.id)
    expect(row).toMatchObject({ status: 'sent', telegram_payment_charge_id: 'charge_1', intro_status: null })
    expect(row.paid_at).not.toBeNull()
    expect(row.sent_at).not.toBeNull()

    const msgs = await sql`select match_id, sender_id, type, gift_transaction_id, body from messages`
    expect(msgs).toEqual([{ type: 'gift', gift_transaction_id: tx.id, sender_id: buyer.id, match_id: tx.match_id, body: null }])

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
    const tx = await chatTx()
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)

    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
    expect((await txRow(tx.id)).status).toBe('refunded')
    expect(await sql`select id from messages`).toHaveLength(0)
  })

  it('marks the tx send_failed (not refunded) when refundGift itself throws', async () => {
    vi.mocked(sendGiftToUser).mockRejectedValueOnce(new Error('insufficient balance'))
    vi.mocked(refundGift).mockRejectedValueOnce(new Error('telegram refund error'))
    const tx = await chatTx()
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)

    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
    expect((await txRow(tx.id)).status).toBe('send_failed')
  })

  it('is idempotent when the tx is not pending (replay)', async () => {
    const tx = await createGiftTx(buyer.id, recipient.id, { status: 'sent' })
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    expect(sendGiftToUser).not.toHaveBeenCalled()
    expect(refundGift).not.toHaveBeenCalled()
    expect((await txRow(tx.id)).status).toBe('sent')
  })

  it('a duplicate payment update (sequential replay) sends exactly once', async () => {
    const tx = await chatTx()
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    expect(sendGiftToUser).toHaveBeenCalledTimes(1)
    expect(await sql`select id from messages`).toHaveLength(1)
  })

  it('concurrent duplicate payment updates send exactly once (atomic claim)', async () => {
    const tx = await chatTx()
    await Promise.all([
      handleGiftPaid(tx.id, 'charge_1', 111, 75),
      handleGiftPaid(tx.id, 'charge_1', 111, 75),
      handleGiftPaid(tx.id, 'charge_1', 111, 75),
    ])
    expect(sendGiftToUser).toHaveBeenCalledTimes(1)
    expect((await txRow(tx.id)).status).toBe('sent')
  })

  it('concurrent duplicates after a failed send refund exactly once', async () => {
    vi.mocked(sendGiftToUser).mockRejectedValue(new Error('insufficient balance'))
    const tx = await chatTx()
    await Promise.all([
      handleGiftPaid(tx.id, 'charge_1', 111, 75),
      handleGiftPaid(tx.id, 'charge_1', 111, 75),
    ])
    expect(refundGift).toHaveBeenCalledTimes(1)
    expect((await txRow(tx.id)).status).toBe('refunded')
  })

  it('ignores a malformed (non-uuid) payload without throwing', async () => {
    await expect(handleGiftPaid('not-a-uuid', 'charge_1', 111, 75)).resolves.toBeUndefined()
    expect(sendGiftToUser).not.toHaveBeenCalled()
  })

  it('sets intro_status pending and notifies via notifyGiftIntro for a discovery gift', async () => {
    await sql`update users set locale = 'ar' where id = ${recipient.id}`
    const tx = await createGiftTx(buyer.id, recipient.id, { context: 'discovery' })
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)

    expect(sendGiftToUser).toHaveBeenCalledWith(recipient.telegram_id, 'g', undefined)
    expect(await txRow(tx.id)).toMatchObject({ status: 'sent', intro_status: 'pending' })
    expect(notifyGiftIntro).toHaveBeenCalledWith(recipient.telegram_id, 'Ali', '🌹', 'ar')
  })

  it('passes the note to sendGift', async () => {
    const tx = await createGiftTx(buyer.id, recipient.id, { note: 'hello' })
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    expect(sendGiftToUser).toHaveBeenCalledWith(recipient.telegram_id, 'g', 'hello')
  })

  it('uses the recipient\'s fallback name and null locale when the row has none', async () => {
    await sql`update users set locale = null where id = ${recipient.id}`
    const tx = await createGiftTx(buyer.id, recipient.id, { context: 'discovery' })
    await forceDeleteUser(buyer.id) // buyer row gone → fallback name
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    expect(notifyGiftIntro).toHaveBeenCalledWith(recipient.telegram_id, fa.notify.fallbackName, '🌹', null)
  })

  it('refunds when the recipient row is gone', async () => {
    const tx = await createGiftTx(buyer.id, recipient.id)
    await forceDeleteUser(recipient.id)
    await handleGiftPaid(tx.id, 'charge_1', 111, 75)
    expect(sendGiftToUser).not.toHaveBeenCalled()
    expect(refundGift).toHaveBeenCalledWith(111, 'charge_1')
    expect((await txRow(tx.id)).status).toBe('refunded')
  })

  it('a failed "sent" status write is logged, not thrown, and the DM/notice still go out', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tx = await chatTx()
    const cleanup = await failWritesTo('gift_transactions', 'UPDATE', "(new.status = 'sent')")
    try {
      await expect(handleGiftPaid(tx.id, 'charge_1', 111, 75)).resolves.toBeUndefined()
    } finally {
      await cleanup()
      errSpy.mockRestore()
    }
    expect((await txRow(tx.id)).status).toBe('paid')
    expect(refundGift).not.toHaveBeenCalled()
    expect(notifyPaymentChannel).toHaveBeenCalledTimes(1)
    expect(notifyNewMessage).toHaveBeenCalledTimes(1)
  })

  it('a failed gift-message insert is logged, not thrown, and the recipient is still notified', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tx = await chatTx()
    const cleanup = await failWritesTo('messages', 'INSERT')
    try {
      await expect(handleGiftPaid(tx.id, 'charge_1', 111, 75)).resolves.toBeUndefined()
    } finally {
      await cleanup()
      errSpy.mockRestore()
    }
    expect((await txRow(tx.id)).status).toBe('sent')
    expect(notifyNewMessage).toHaveBeenCalledTimes(1)
  })
})

describe('validatePreCheckout', () => {
  async function pending(overrides: Record<string, unknown> = {}) {
    return createGiftTx(buyer.id, recipient.id, { charged_stars: 75, ...overrides })
  }

  it('rejects an unknown tx in Persian', async () => {
    expect(await validatePreCheckout('00000000-0000-0000-0000-000000000000', 75, 'XTR'))
      .toEqual({ ok: false, reason: fa.gifts.checkoutUnavailable })
  })
  it('rejects a malformed (non-uuid) payload as unknown, not a crash', async () => {
    expect(await validatePreCheckout('garbage', 75, 'XTR')).toEqual({ ok: false, reason: fa.gifts.checkoutUnavailable })
  })
  it('rejects an already-processed tx in the buyer\'s language', async () => {
    await sql`update users set locale = 'en' where id = ${buyer.id}`
    const tx = await pending({ status: 'paid' })
    expect(await validatePreCheckout(tx.id, 75, 'XTR')).toEqual({ ok: false, reason: en.gifts.checkoutAlreadyProcessed })
  })
  it('rejects a price mismatch in the buyer\'s language', async () => {
    await sql`update users set locale = 'en' where id = ${buyer.id}`
    const tx = await pending()
    expect(await validatePreCheckout(tx.id, 10, 'XTR')).toEqual({ ok: false, reason: en.gifts.checkoutPriceMismatch })
  })
  it('accepts a pending tx with the right amount and an available gift', async () => {
    const tx = await pending()
    expect(await validatePreCheckout(tx.id, 75, 'XTR')).toEqual({ ok: true })
  })
})
