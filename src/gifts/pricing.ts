/** Compute what the buyer is charged (in Stars) and the operator's margin. */
export function computeCharge(
  giftStarCost: number,
  markupPercent: number,
  overrideChargedStars?: number | null,
): { chargedStars: number; markupStars: number } {
  const chargedStars =
    overrideChargedStars != null
      ? overrideChargedStars
      : Math.ceil(giftStarCost * (1 + markupPercent / 100))
  return { chargedStars, markupStars: Math.max(0, chargedStars - giftStarCost) }
}
