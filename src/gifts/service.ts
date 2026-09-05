import { db } from '../db.js'
import { computeCharge } from './pricing.js'
import {
  getGiftCatalog, createGiftInvoiceLink, sendGiftToUser, refundGift,
  notifyNewMessage, notifyGiftIntro, notifyPaymentChannel,
} from '../bot.js'
import { formatGiftPaidNotice } from '../payments/paymentNotify.js'
import { t } from '../i18n/index.js'

const CATALOG_TTL_MS = 5 * 60 * 1000
let catalogCache: { at: number; gifts: { id: string; emoji: string | null; starCost: number }[] } | null = null

async function loadRawCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.gifts
  const gifts = await getGiftCatalog()
  const mapped = gifts
    // Drop sold-out limited gifts (regular gifts have neither field) — both the global
    // remaining stock and the bot's own allocation must be non-zero, since sendGift draws
    // from personal_remaining_count and a global-only check can pass a gift the bot can't send.
    .filter((g) => (g.remaining_count === undefined || g.remaining_count > 0)
      && (g.personal_remaining_count === undefined || g.personal_remaining_count > 0))
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
      .select('user1_id, user2_id, user1:users!matches_user1_id_fkey(id, telegram_id, deleted_at, banned_at), user2:users!matches_user2_id_fkey(id, telegram_id, deleted_at, banned_at)')
      .eq('id', matchId).single()
    if (!m || (m.user1_id !== buyerId && m.user2_id !== buyerId)) return { error: 'match_not_found' }
    const other: any = m.user1_id === buyerId ? m.user2 : m.user1
    if (!other || other.deleted_at || other.banned_at) return { error: 'recipient_unavailable' }
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
    tx.id, t.gifts.invoiceTitle(gift.emoji ?? '🎁'), t.gifts.invoiceDescription, chargedStars,
  )
  return { transactionId: tx.id, invoiceLink }
}

export async function validatePreCheckout(payload: string, totalAmount: number, currency: string) {
  const { data: tx } = await db
    .from('gift_transactions').select('status, charged_stars, gift_id').eq('id', payload).maybeSingle()
  if (!tx) return { ok: false as const, reason: t.gifts.checkoutUnavailable }
  if (tx.status !== 'pending_payment') return { ok: false as const, reason: t.gifts.checkoutAlreadyProcessed }
  if (currency !== 'XTR' || totalAmount !== tx.charged_stars) return { ok: false as const, reason: t.gifts.checkoutPriceMismatch }
  const catalog = await loadRawCatalog()
  if (!catalog.find((g) => g.id === tx.gift_id)) return { ok: false as const, reason: t.gifts.checkoutSoldOut }
  return { ok: true as const }
}

export async function handleGiftPaid(payload: string, chargeId: string, buyerTelegramId: number, amountStars: number) {
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

  {
    const { error: sentErr } = await db.from('gift_transactions').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', tx.id)
    if (sentErr) console.error(`[gifts] failed to mark tx ${tx.id} as sent:`, sentErr)
  }

  // Gift delivered — post an ops notice (best-effort; never blocks the payment).
  notifyPaymentChannel(formatGiftPaidNotice({
    buyerName: buyer?.name ?? null,
    recipientName: recipient.name ?? null,
    giftEmoji: tx.gift_emoji ?? null,
    amountStars,
    chargeId,
    at: new Date().toISOString(),
  })).catch(() => {})

  if (tx.context === 'chat' && tx.match_id) {
    const { error: msgErr } = await db.from('messages').insert({
      match_id: tx.match_id, sender_id: tx.buyer_id, type: 'gift', gift_transaction_id: tx.id, body: null,
    })
    if (msgErr) console.error(`[gifts] failed to insert gift message for tx ${tx.id}:`, msgErr)
    if (recipient.telegram_id) {
      notifyNewMessage(recipient.telegram_id, buyer?.name ?? t.notify.fallbackName, t.gifts.sentYouGift(tx.gift_emoji ?? '🎁'))
        .catch(() => {})
    }
  } else {
    const { error: introErr } = await db.from('gift_transactions').update({ intro_status: 'pending' }).eq('id', tx.id)
    if (introErr) console.error(`[gifts] failed to set intro_status for tx ${tx.id}:`, introErr)
    if (recipient.telegram_id) {
      notifyGiftIntro(recipient.telegram_id, buyer?.name ?? t.notify.fallbackName, tx.gift_emoji ?? '🎁').catch(() => {})
    }
  }
}

async function failAndRefund(txId: string, buyerTelegramId: number, chargeId: string) {
  try {
    await refundGift(buyerTelegramId, chargeId)
    await db.from('gift_transactions').update({ status: 'refunded' }).eq('id', txId)
  } catch (e) {
    console.error('[gifts] refund failed:', (e as Error)?.message)
    await db.from('gift_transactions').update({ status: 'send_failed' }).eq('id', txId)
  }
}

export async function getTransactionStatus(txId: string, userId: string) {
  const { data } = await db
    .from('gift_transactions').select('status, intro_status, buyer_id').eq('id', txId).maybeSingle()
  if (!data || data.buyer_id !== userId) return null
  return { status: data.status, introStatus: data.intro_status ?? null }
}

export async function listPendingIntros(userId: string) {
  const { data } = await db
    .from('gift_transactions')
    .select('id, note, gift_emoji, created_at, buyer:users!gift_transactions_buyer_id_fkey(id, name, user_photos(url, position))')
    .eq('recipient_id', userId).eq('context', 'discovery').eq('intro_status', 'pending')
    .order('created_at', { ascending: false })
  return (data ?? []).map((r: any) => ({
    id: r.id,
    buyer: {
      id: r.buyer?.id,
      name: r.buyer?.name ?? '',
      photo: (r.buyer?.user_photos ?? []).sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null,
    },
    emoji: r.gift_emoji ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
  }))
}

/** Determine why a claim update matched nothing: unknown/foreign tx vs. already-handled. */
async function resolveClaimMiss(introId: string, userId: string): Promise<{ error: string }> {
  const { data: tx } = await db
    .from('gift_transactions').select('recipient_id, intro_status').eq('id', introId).maybeSingle()
  if (!tx || tx.recipient_id !== userId) return { error: 'not_found' }
  return { error: 'already_handled' }
}

/**
 * Compensate a won claim when match creation fails: revert intro_status back to 'pending'
 * so the intro stays retryable instead of getting stuck 'accepted' with no match_id.
 */
async function revertClaim(introId: string): Promise<{ error: string }> {
  await db.from('gift_transactions').update({ intro_status: 'pending' }).eq('id', introId)
  return { error: 'match_failed' }
}

export async function acceptIntro(introId: string, userId: string) {
  // Atomic claim: only a still-pending row owned by this recipient flips to 'accepted'.
  // This guards against a double-tap/retry racing two concurrent accepts, which would
  // otherwise both pass a SELECT-then-UPDATE guard and seed two gift messages.
  const { data: claimed } = await db
    .from('gift_transactions')
    .update({ intro_status: 'accepted' })
    .eq('id', introId).eq('recipient_id', userId).eq('intro_status', 'pending')
    .select('id, buyer_id, recipient_id').maybeSingle()
  if (!claimed) return resolveClaimMiss(introId, userId)

  // Normalise pair order to satisfy UNIQUE(user1_id, user2_id).
  const [u1, u2] = [claimed.buyer_id, claimed.recipient_id].sort()
  let matchId: string
  const { data: created, error: insErr } = await db
    .from('matches').insert({ user1_id: u1, user2_id: u2 }).select('id').maybeSingle()
  if (created) {
    matchId = created.id
  } else if (insErr?.code === '23505') {
    const { data: existing } = await db
      .from('matches').select('id').eq('user1_id', u1).eq('user2_id', u2).single()
    if (!existing) return revertClaim(introId)
    matchId = existing.id
  } else {
    return revertClaim(introId)
  }

  await db.from('gift_transactions').update({ match_id: matchId }).eq('id', claimed.id)
  // Seed the gift as the first message so the new chat opens with it.
  await db.from('messages').insert({
    match_id: matchId, sender_id: claimed.buyer_id, type: 'gift', gift_transaction_id: claimed.id, body: null,
  })
  return { matchId }
}

export async function dismissIntro(introId: string, userId: string) {
  // Atomic claim, same rationale as acceptIntro: avoids a SELECT-then-UPDATE race.
  const { data: claimed } = await db
    .from('gift_transactions')
    .update({ intro_status: 'dismissed' })
    .eq('id', introId).eq('recipient_id', userId).eq('intro_status', 'pending')
    .select('id').maybeSingle()
  if (!claimed) return resolveClaimMiss(introId, userId)
  return { ok: true as const }
}
