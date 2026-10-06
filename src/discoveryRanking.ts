// Pure ranking helpers for the discovery feed — no DB or Fastify knowledge.

/**
 * Merge the discovery tiers into one batch. Likers occupy `likerPositions`
 * (skipped, not left as gaps, when likers run out); remaining slots are filled
 * from `fillerTiers` in priority order (same city, same country, rest).
 * Duplicates are kept in their highest tier only.
 */
export function interleaveBatch<T extends { id: string }>(
  likers: T[],
  fillerTiers: T[][],
  batchSize: number,
  likerPositions: number[],
): T[] {
  const seen = new Set<string>()
  const dedupe = (arr: T[]) =>
    arr.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))

  const likerPool = dedupe(likers)
  const fillerPool = fillerTiers.flatMap(dedupe)
  const likerSlots = new Set(likerPositions)

  const result: T[] = []
  while (result.length < batchSize && (likerPool.length > 0 || fillerPool.length > 0)) {
    if (likerSlots.has(result.length) && likerPool.length > 0) {
      result.push(likerPool.shift()!)
    } else if (fillerPool.length > 0) {
      result.push(fillerPool.shift()!)
    } else {
      result.push(likerPool.shift()!)
    }
  }
  return result
}

/**
 * Fisher–Yates in-place shuffle (also returns the array). Uses Math.random, so
 * each call yields a fresh order — this is for feed variety only, not anything
 * security-sensitive.
 */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

type Located = { geo_city?: string | null; geo_country?: string | null }

/**
 * Same-city test for the "nearby" badge: both resolved to the same normalized
 * city in the same country. The typed location is never compared.
 */
export function isSameCity(a: Located, b: Located): boolean {
  return Boolean(a.geo_city && a.geo_country && a.geo_city === b.geo_city && a.geo_country === b.geo_country)
}
