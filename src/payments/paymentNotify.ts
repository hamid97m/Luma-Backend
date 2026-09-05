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
