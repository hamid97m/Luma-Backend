import { db } from '../db.js'
import { computeCharge } from './pricing.js'
import {
  getGiftCatalog, createGiftInvoiceLink, sendGiftToUser, refundGift,
  notifyNewMessage, notifyGiftIntro,
} from '../bot.js'

const CATALOG_TTL_MS = 5 * 60 * 1000
let catalogCache: { at: number; gifts: { id: string; emoji: string | null; starCost: number }[] } | null = null

async function loadRawCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.gifts
  const gifts = await getGiftCatalog()
  const mapped = gifts
    // Drop sold-out limited gifts (regular gifts have no remaining_count).
    .filter((g) => g.remaining_count === undefined || g.remaining_count > 0)
    .map((g) => ({ id: g.id, emoji: g.sticker?.emoji ?? null, starCost: g.star_count }))
  catalogCache = { at: Date.now(), gifts: mapped }
  return mapped
}

async function pricingConfig() {
  const { data } = await db.from('gift_config').select('markup_percent').eq('id', true).single()
  return { markupPercent: data?.markup_percent ?? 33 }
}

async function overrideFor(giftId: string): Promise<number | null> {
  const { data } = await db.from('gift_price_overrides').select('charged_stars').eq('gift_id', giftId).maybeSingle()
  return data?.charged_stars ?? null
}

export async function getCatalogForBuyer() {
  const [gifts, cfg] = await Promise.all([loadRawCatalog(), pricingConfig()])
  const overrides = await db.from('gift_price_overrides').select('gift_id, charged_stars')
  const ovMap = new Map((overrides.data ?? []).map((o: any) => [o.gift_id, o.charged_stars]))
  return gifts.map((g) => {
    const { chargedStars } = computeCharge(g.starCost, cfg.markupPercent, ovMap.get(g.id) ?? null)
    return { giftId: g.id, emoji: g.emoji, starCost: g.starCost, chargedStars }
  })
}

/** Resolve the recipient's users.id + telegram_id for either surface. */
async function resolveRecipient(
  buyerId: string, context: 'chat' | 'discovery', matchId?: string, targetUserId?: string,
): Promise<{ id: string; telegramId: number } | { error: string }> {
  if (context === 'chat') {
    if (!matchId) return { error: 'match_required' }
    const { data: m } = await db
      .from('matches')
      .select('user1_id, user2_id, user1:users!matches_user1_id_fkey(id, telegram_id, deleted_at), user2:users!matches_user2_id_fkey(id, telegram_id, deleted_at)')
      .eq('id', matchId).single()
    if (!m || (m.user1_id !== buyerId && m.user2_id !== buyerId)) return { error: 'match_not_found' }
    const other: any = m.user1_id === buyerId ? m.user2 : m.user1
    if (!other || other.deleted_at) return { error: 'recipient_unavailable' }
    return { id: other.id, telegramId: other.telegram_id }
  }
  if (!targetUserId) return { error: 'target_required' }
  const { data: u } = await db.from('users').select('id, telegram_id, deleted_at, banned_at').eq('id', targetUserId).single()
  if (!u || u.deleted_at || u.banned_at) return { error: 'recipient_unavailable' }
  return { id: u.id, telegramId: u.telegram_id }
}

export async function createGiftCheckout(input: {
  buyerId: string; context: 'chat' | 'discovery'; matchId?: string; targetUserId?: string; giftId: string; note?: string
}) {
  const recipient = await resolveRecipient(input.buyerId, input.context, input.matchId, input.targetUserId)
  if ('error' in recipient) return recipient
  if (recipient.id === input.buyerId) return { error: 'cannot_gift_self' }

  const catalog = await loadRawCatalog()
  const gift = catalog.find((g) => g.id === input.giftId)
  if (!gift) return { error: 'gift_unavailable' }

  const cfg = await pricingConfig()
  const { chargedStars, markupStars } = computeCharge(gift.starCost, cfg.markupPercent, await overrideFor(gift.id))
  const note = input.note?.trim().slice(0, 128) || null

  const { data: tx, error } = await db.from('gift_transactions').insert({
    buyer_id: input.buyerId, recipient_id: recipient.id, context: input.context,
    match_id: input.context === 'chat' ? input.matchId : null,
    gift_id: gift.id, gift_emoji: gift.emoji, gift_star_cost: gift.starCost,
    charged_stars: chargedStars, markup_stars: markupStars, note,
    status: 'pending_payment',
  }).select('id').single()
  if (error || !tx) return { error: 'checkout_failed' }

  const invoiceLink = await createGiftInvoiceLink(
    tx.id, `Gift ${gift.emoji ?? '🎁'}`, 'Send a gift', chargedStars,
  )
  return { transactionId: tx.id, invoiceLink }
}

export async function validatePreCheckout(payload: string, totalAmount: number, currency: string) {
  const { data: tx } = await db
    .from('gift_transactions').select('status, charged_stars, gift_id').eq('id', payload).maybeSingle()
  if (!tx) return { ok: false as const, reason: 'This gift is no longer available.' }
  if (tx.status !== 'pending_payment') return { ok: false as const, reason: 'This gift was already processed.' }
  if (currency !== 'XTR' || totalAmount !== tx.charged_stars) return { ok: false as const, reason: 'Price mismatch.' }
  const catalog = await loadRawCatalog()
  if (!catalog.find((g) => g.id === tx.gift_id)) return { ok: false as const, reason: 'This gift just sold out.' }
  return { ok: true as const }
}

export async function handleGiftPaid(payload: string, chargeId: string, buyerTelegramId: number) {
  // Idempotency: only a still-pending row proceeds (guards double delivery on update replays).
  const { data: tx } = await db
    .from('gift_transactions')
    .update({ status: 'paid', paid_at: new Date().toISOString(), telegram_payment_charge_id: chargeId })
    .eq('id', payload).eq('status', 'pending_payment')
    .select('id, buyer_id, recipient_id, context, match_id, gift_id, gift_emoji, note').maybeSingle()
  if (!tx) return // already handled or unknown

  const { data: recipient } = await db.from('users').select('telegram_id, name').eq('id', tx.recipient_id).single()
  const { data: buyer } = await db.from('users').select('name').eq('id', tx.buyer_id).single()
  if (!recipient) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }

  try {
    await sendGiftToUser(recipient.telegram_id, tx.gift_id, tx.note ?? undefined)
  } catch (err) {
    console.error('[gifts] sendGift failed, refunding:', (err as Error)?.message)
    await failAndRefund(tx.id, buyerTelegramId, chargeId)
    return
  }

  await db.from('gift_transactions').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', tx.id)

  if (tx.context === 'chat' && tx.match_id) {
    await db.from('messages').insert({
      match_id: tx.match_id, sender_id: tx.buyer_id, type: 'gift', gift_transaction_id: tx.id, body: null,
    })
    if (recipient.telegram_id) {
      notifyNewMessage(recipient.telegram_id, buyer?.name ?? 'Someone', `sent you a gift ${tx.gift_emoji ?? '🎁'}`)
        .catch(() => {})
    }
  } else {
    await db.from('gift_transactions').update({ intro_status: 'pending' }).eq('id', tx.id)
    notifyGiftIntro(recipient.telegram_id, buyer?.name ?? 'Someone', tx.gift_emoji ?? '🎁').catch(() => {})
  }
}

async function failAndRefund(txId: string, buyerTelegramId: number, chargeId: string) {
  try { await refundGift(buyerTelegramId, chargeId) } catch (e) { console.error('[gifts] refund failed:', (e as Error)?.message) }
  await db.from('gift_transactions').update({ status: 'refunded' }).eq('id', txId)
}

export async function getTransactionStatus(txId: string, userId: string) {
  const { data } = await db
    .from('gift_transactions').select('status, intro_status, buyer_id').eq('id', txId).maybeSingle()
  if (!data || data.buyer_id !== userId) return null
  return { status: data.status, introStatus: data.intro_status ?? null }
}
