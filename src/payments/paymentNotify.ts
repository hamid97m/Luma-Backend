// Formats the ops notifications posted to the payment-notify channel on every
// confirmed Stars purchase. Kept as pure string builders (no Telegram/db deps)
// so the exact wording is unit-testable. These are internal admin/audit
// messages — English labels + Latin digits, not user-facing i18n copy.

export interface PremiumPaidNotice {
  buyerName: string | null
  durationDays: number
  amountStars: number
  chargeId: string
  at: string // ISO timestamp
}

export interface TonPaysPaidNotice {
  buyerName: string | null
  durationDays: number
  amountToman: number
  invoiceId: string
  at: string // ISO timestamp
}

export interface TonPaysGrantFailedNotice {
  buyerName: string | null
  amountToman: number
  invoiceId: string
  reason: string
  at: string // ISO timestamp
}

export interface GiftPaidNotice {
  buyerName: string | null
  recipientName: string | null
  giftEmoji: string | null
  amountStars: number
  chargeId: string
  at: string // ISO timestamp
}

const UNKNOWN = 'unknown'

export function formatPremiumPaidNotice(n: PremiumPaidNotice): string {
  return [
    '💎 Premium purchased',
    `Buyer: ${n.buyerName ?? UNKNOWN}`,
    `Duration: ${n.durationDays} days`,
    `Amount: ${n.amountStars} ⭐`,
    `Charge: ${n.chargeId}`,
    `Time: ${n.at}`,
  ].join('\n')
}

export function formatTonPaysPaidNotice(n: TonPaysPaidNotice): string {
  return [
    '💎 Premium purchased (TonPays)',
    `Buyer: ${n.buyerName ?? UNKNOWN}`,
    `Duration: ${n.durationDays} days`,
    `Amount: ${n.amountToman} Toman`,
    `Invoice: ${n.invoiceId}`,
    `Time: ${n.at}`,
  ].join('\n')
}

/** The one payment case that always needs a human: TonPays confirmed the
 * transfer but we couldn't grant the premium, and a card-to-card payment has
 * no auto-refund path. Deliberately alarming, and posted to the same channel
 * that reports successes so ops can't miss it. */
export function formatTonPaysGrantFailedNotice(n: TonPaysGrantFailedNotice): string {
  return [
    '🚨 TonPays payment received but grant FAILED',
    `Buyer: ${n.buyerName ?? UNKNOWN}`,
    `Amount: ${n.amountToman} Toman`,
    `Invoice: ${n.invoiceId}`,
    `Reason: ${n.reason}`,
    `Time: ${n.at}`,
    'Action: grant premium manually (admin panel → Premium → grant)',
  ].join('\n')
}

export function formatGiftPaidNotice(n: GiftPaidNotice): string {
  return [
    '🎁 Gift sent',
    `Buyer: ${n.buyerName ?? UNKNOWN}`,
    `Recipient: ${n.recipientName ?? UNKNOWN}`,
    `Gift: ${n.giftEmoji ?? '🎁'}`,
    `Amount: ${n.amountStars} ⭐`,
    `Charge: ${n.chargeId}`,
    `Time: ${n.at}`,
  ].join('\n')
}
