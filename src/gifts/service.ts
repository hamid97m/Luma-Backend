import { sql, isUuid } from '../db.js'
import { computeCharge } from './pricing.js'
import {
  getGiftCatalog, createGiftInvoiceLink, sendGiftToUser, refundGift,
  notifyNewMessage, notifyGiftIntro, notifyPaymentChannel,
} from '../bot.js'
import { formatGiftPaidNotice } from '../payments/paymentNotify.js'
import { tFor, type Locale } from '../i18n/index.js'
import { seedIcebreakers } from '../icebreakers/seed.js'

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

/** Run a read whose failure is tolerated on purpose: a DB error yields
 *  `fallback` instead of throwing. */
async function tolerant<T extends readonly unknown[]>(query: () => PromiseLike<T>, fallback: T | []): Promise<T | []> {
  try {
    return await query()
  } catch (err) {
    console.error('[gifts] query failed:', (err as Error)?.message)
    return fallback
  }
}

async function pricingConfig() {
  const [row] = await tolerant(() => sql`select markup_percent from gift_config where id = true`, [])
  return { markupPercent: (row?.markup_percent as number | undefined) ?? 33 }
}

async function overrideFor(giftId: string): Promise<number | null> {
  const [row] = await tolerant(
    () => sql`select charged_stars from gift_price_overrides where gift_id = ${giftId}`, [],
  )
  return (row?.charged_stars as number | undefined) ?? null
}

export async function getCatalogForBuyer() {
  const [gifts, cfg] = await Promise.all([loadRawCatalog(), pricingConfig()])
  const overrides = await tolerant(() => sql`select gift_id, charged_stars from gift_price_overrides`, [])
  const ovMap = new Map(overrides.map((o: any) => [o.gift_id, o.charged_stars]))
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
    // A non-uuid matchId can't be a match: answer "no rows" (Postgres would throw on the cast).
    const [m] = isUuid(matchId)
      ? await tolerant(() => sql`
          select m.user1_id, m.user2_id,
            case when u1.id is null then null else json_build_object(
              'id', u1.id, 'telegram_id', u1.telegram_id, 'deleted_at', u1.deleted_at, 'banned_at', u1.banned_at) end as user1,
            case when u2.id is null then null else json_build_object(
              'id', u2.id, 'telegram_id', u2.telegram_id, 'deleted_at', u2.deleted_at, 'banned_at', u2.banned_at) end as user2
          from matches m
          left join users u1 on u1.id = m.user1_id
          left join users u2 on u2.id = m.user2_id
          where m.id = ${matchId}`, [])
      : []
    if (!m || (m.user1_id !== buyerId && m.user2_id !== buyerId)) return { error: 'match_not_found' }
    const other: any = m.user1_id === buyerId ? m.user2 : m.user1
    // Star gifts are delivered over Telegram: a website-only user can't receive one.
    if (!other || other.deleted_at || other.banned_at || other.telegram_id == null) return { error: 'recipient_unavailable' }
    return { id: other.id, telegramId: other.telegram_id }
  }
  if (!targetUserId) return { error: 'target_required' }
  const [u] = isUuid(targetUserId)
    ? await tolerant(() => sql`select id, telegram_id, deleted_at, banned_at from users where id = ${targetUserId}`, [])
    : []
  if (!u || u.deleted_at || u.banned_at || u.telegram_id == null) return { error: 'recipient_unavailable' }
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

  let tx: { id: string } | undefined
  try {
    ;[tx] = await sql<{ id: string }[]>`
      insert into gift_transactions ${sql({
        buyer_id: input.buyerId, recipient_id: recipient.id, context: input.context,
        match_id: input.context === 'chat' ? input.matchId ?? null : null,
        gift_id: gift.id, gift_emoji: gift.emoji, gift_star_cost: gift.starCost,
        charged_stars: chargedStars, markup_stars: markupStars, note,
        status: 'pending_payment',
      })}
      returning id`
  } catch (err) {
    console.error('[gifts] checkout insert failed:', (err as Error)?.message)
  }
  if (!tx) return { error: 'checkout_failed' }

  // Invoice copy follows the buyer's language (the buyer is the caller).
  const [buyer] = await tolerant(() => sql`select locale from users where id = ${input.buyerId}`, [])
  const t = tFor((buyer?.locale as Locale | null) ?? null)
  const invoiceLink = await createGiftInvoiceLink(
    tx.id, t.gifts.invoiceTitle(gift.emoji ?? '🎁'), t.gifts.invoiceDescription, chargedStars,
  )
  return { transactionId: tx.id, invoiceLink }
}

export async function validatePreCheckout(payload: string, totalAmount: number, currency: string) {
  // The payload is a gift_transactions.id we minted; anything else is an unknown tx.
  const [tx] = isUuid(payload)
    ? await tolerant(() => sql`
        select status, charged_stars, gift_id, buyer_id from gift_transactions where id = ${payload}`, [])
    : []
  // Unknown tx → no buyer to look up, so the rejection falls back to Persian.
  if (!tx) return { ok: false as const, reason: tFor(null).gifts.checkoutUnavailable }
  const [buyer] = await tolerant(() => sql`select locale from users where id = ${tx.buyer_id}`, [])
  const t = tFor((buyer?.locale as Locale | null) ?? null)
  if (tx.status !== 'pending_payment') return { ok: false as const, reason: t.gifts.checkoutAlreadyProcessed }
  if (currency !== 'XTR' || totalAmount !== tx.charged_stars) return { ok: false as const, reason: t.gifts.checkoutPriceMismatch }
  const catalog = await loadRawCatalog()
  if (!catalog.find((g) => g.id === tx.gift_id)) return { ok: false as const, reason: t.gifts.checkoutSoldOut }
  return { ok: true as const }
}

export async function handleGiftPaid(payload: string, chargeId: string, buyerTelegramId: number, amountStars: number) {
  if (!isUuid(payload)) return // unknown
  // Idempotency: only a still-pending row proceeds (guards double delivery on update replays).
  // One conditional statement — a replayed/concurrent update finds no pending row and stops here.
  const [tx] = await sql`
    update gift_transactions
    set status = 'paid', paid_at = ${new Date().toISOString()}, telegram_payment_charge_id = ${chargeId}
    where id = ${payload} and status = 'pending_payment'
    returning id, buyer_id, recipient_id, context, match_id, gift_id, gift_emoji, note`
  if (!tx) return // already handled or unknown

  // A failed lookup used to come back as `data: null` — keep that (missing recipient → refund).
  const [recipient] = await tolerant(() => sql`select telegram_id, name, locale from users where id = ${tx.recipient_id}`, [])
  const [buyer] = await tolerant(() => sql`select name from users where id = ${tx.buyer_id}`, [])
  // No Telegram account (website-only user) → the gift can't be delivered; refund.
  if (!recipient || recipient.telegram_id == null) { await failAndRefund(tx.id, buyerTelegramId, chargeId); return }
  // DMs below go to the recipient, so they're worded in the recipient's language.
  const recipientLocale = (recipient.locale as Locale | null) ?? null
  const rt = tFor(recipientLocale)

  try {
    await sendGiftToUser(recipient.telegram_id, tx.gift_id, tx.note ?? undefined)
  } catch (err) {
    console.error('[gifts] sendGift failed, refunding:', (err as Error)?.message)
    await failAndRefund(tx.id, buyerTelegramId, chargeId)
    return
  }

  try {
    await sql`
      update gift_transactions set status = 'sent', sent_at = ${new Date().toISOString()}
      where id = ${tx.id} and status = 'paid'`
  } catch (sentErr) {
    console.error(`[gifts] failed to mark tx ${tx.id} as sent:`, sentErr)
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
    try {
      await sql`
        insert into messages (match_id, sender_id, type, gift_transaction_id, body)
        values (${tx.match_id}, ${tx.buyer_id}, 'gift', ${tx.id}, null)`
    } catch (msgErr) {
      console.error(`[gifts] failed to insert gift message for tx ${tx.id}:`, msgErr)
    }
    if (recipient.telegram_id) {
      notifyNewMessage(recipient.telegram_id, buyer?.name ?? rt.notify.fallbackName, rt.gifts.sentYouGift(tx.gift_emoji ?? '🎁'), null, undefined, recipientLocale)
        .catch(() => {})
    }
  } else {
    try {
      await sql`update gift_transactions set intro_status = 'pending' where id = ${tx.id}`
    } catch (introErr) {
      console.error(`[gifts] failed to set intro_status for tx ${tx.id}:`, introErr)
    }
    if (recipient.telegram_id) {
      notifyGiftIntro(recipient.telegram_id, buyer?.name ?? rt.notify.fallbackName, tx.gift_emoji ?? '🎁', recipientLocale).catch(() => {})
    }
  }
}

async function failAndRefund(txId: string, buyerTelegramId: number, chargeId: string) {
  // Only the caller that claimed the row (pending_payment → paid) gets here, so each
  // transition is conditional on 'paid' and happens at most once.
  try {
    await refundGift(buyerTelegramId, chargeId)
  } catch (e) {
    console.error('[gifts] refund failed:', (e as Error)?.message)
    await sql`update gift_transactions set status = 'send_failed' where id = ${txId} and status = 'paid'`
    return
  }
  // The refund went through: a failed status write must not be recorded as send_failed.
  try {
    await sql`update gift_transactions set status = 'refunded' where id = ${txId} and status = 'paid'`
  } catch (e) {
    console.error(`[gifts] refunded tx ${txId} but failed to record it:`, (e as Error)?.message)
  }
}

export async function getTransactionStatus(txId: string, userId: string) {
  const [data] = isUuid(txId)
    ? await sql`select status, intro_status, buyer_id from gift_transactions where id = ${txId}`
    : []
  if (!data || data.buyer_id !== userId) return null
  return { status: data.status, introStatus: data.intro_status ?? null }
}

export async function listPendingIntros(userId: string) {
  const data = await sql`
    select t.id, t.note, t.gift_emoji, t.created_at,
      case when u.id is null then null else json_build_object(
        'id', u.id, 'name', u.name, 'deleted_at', u.deleted_at, 'banned_at', u.banned_at,
        'user_photos', coalesce((
          select json_agg(json_build_object('url', p.url, 'position', p.position))
          from user_photos p where p.user_id = u.id), '[]'::json)
      ) end as buyer
    from gift_transactions t
    left join users u on u.id = t.buyer_id
    where t.recipient_id = ${userId} and t.context = 'discovery' and t.intro_status = 'pending'
    order by t.created_at desc`
  return data
    // Hide intros from buyers who deleted their account or got banned since sending
    // (same availability rule as resolveRecipient).
    .filter((r: any) => r.buyer && !r.buyer.deleted_at && !r.buyer.banned_at)
    .map((r: any) => ({
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
  const [tx] = isUuid(introId)
    ? await sql`select recipient_id, intro_status from gift_transactions where id = ${introId}`
    : []
  if (!tx || tx.recipient_id !== userId) return { error: 'not_found' }
  return { error: 'already_handled' }
}

/**
 * Compensate a won claim when match creation fails: revert intro_status back to 'pending'
 * so the intro stays retryable instead of getting stuck 'accepted' with no match_id.
 */
async function revertClaim(introId: string): Promise<{ error: string }> {
  try {
    await sql`update gift_transactions set intro_status = 'pending' where id = ${introId} and intro_status = 'accepted'`
  } catch (err) {
    console.error(`[gifts] failed to revert intro claim ${introId}:`, (err as Error)?.message)
  }
  return { error: 'match_failed' }
}

export async function acceptIntro(introId: string, userId: string) {
  // Atomic claim: only a still-pending row owned by this recipient flips to 'accepted'.
  // This guards against a double-tap/retry racing two concurrent accepts, which would
  // otherwise both pass a SELECT-then-UPDATE guard and seed two gift messages.
  if (!isUuid(introId)) return { error: 'not_found' }
  const [claimed] = await sql`
    update gift_transactions set intro_status = 'accepted'
    where id = ${introId} and recipient_id = ${userId} and intro_status = 'pending'
    returning id, buyer_id, recipient_id`
  if (!claimed) return resolveClaimMiss(introId, userId)

  // The buyer may have soft-deleted their account (or been banned) since sending the
  // intro — never create a match with an unavailable user (same rule as resolveRecipient).
  // Retire the claimed intro like a decline so it never resurfaces in the inbox.
  const [buyer] = await tolerant(
    () => sql`select deleted_at, banned_at from users where id = ${claimed.buyer_id}`, [],
  )
  if (!buyer || buyer.deleted_at || buyer.banned_at) {
    await sql`update gift_transactions set intro_status = 'dismissed' where id = ${claimed.id}`
    return { error: 'buyer_unavailable' }
  }

  // Normalise pair order to satisfy UNIQUE(user1_id, user2_id).
  const [u1, u2] = [claimed.buyer_id, claimed.recipient_id].sort()
  let matchId: string
  let matchCreated = false
  let created: { id: string } | undefined
  let insErr: { code?: string } | null = null
  try {
    ;[created] = await sql<{ id: string }[]>`
      insert into matches (user1_id, user2_id) values (${u1}, ${u2}) returning id`
  } catch (err) {
    insErr = err as { code?: string }
  }
  if (created) {
    matchId = created.id
    matchCreated = true
  } else if (insErr?.code === '23505') {
    const [existing] = await tolerant(
      () => sql<{ id: string }[]>`select id from matches where user1_id = ${u1} and user2_id = ${u2}`, [],
    )
    if (!existing) return revertClaim(introId)
    matchId = existing.id
  } else {
    console.error('[gifts] intro match insert failed:', (insErr as Error | null)?.message)
    return revertClaim(introId)
  }

  // Both writes were best-effort before (errors ignored); keep accept answering { matchId }.
  try {
    await sql`update gift_transactions set match_id = ${matchId} where id = ${claimed.id}`
  } catch (err) {
    console.error(`[gifts] failed to link intro ${claimed.id} to match:`, (err as Error)?.message)
  }
  // Seed the gift as the first message so the new chat opens with it.
  try {
    await sql`
      insert into messages (match_id, sender_id, type, gift_transaction_id, body)
      values (${matchId}, ${claimed.buyer_id}, 'gift', ${claimed.id}, null)`
  } catch (err) {
    console.error(`[gifts] failed to seed gift message for intro ${claimed.id}:`, (err as Error)?.message)
  }
  if (matchCreated) await seedIcebreakers(matchId, [claimed.buyer_id, claimed.recipient_id])
  return { matchId }
}

export async function dismissIntro(introId: string, userId: string) {
  // Atomic claim, same rationale as acceptIntro: avoids a SELECT-then-UPDATE race.
  if (!isUuid(introId)) return { error: 'not_found' }
  const [claimed] = await sql`
    update gift_transactions set intro_status = 'dismissed'
    where id = ${introId} and recipient_id = ${userId} and intro_status = 'pending'
    returning id`
  if (!claimed) return resolveClaimMiss(introId, userId)
  return { ok: true as const }
}
