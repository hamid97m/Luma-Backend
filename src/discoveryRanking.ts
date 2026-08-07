// Pure ranking helpers for the discovery feed — no DB or Fastify knowledge.

/**
 * Merge the three discovery tiers into one batch. Likers occupy
 * `likerPositions` (skipped, not left as gaps, when likers run out);
 * remaining slots are filled with same-city profiles first, then the rest.
 * Duplicates are kept in their highest tier only.
 */
export function interleaveBatch<T extends { id: string }>(
  likers: T[],
  sameCity: T[],
  rest: T[],
  batchSize: number,
  likerPositions: number[],
): T[] {
  const seen = new Set<string>()
  const dedupe = (arr: T[]) =>
    arr.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))

  const likerPool = dedupe(likers)
  const fillerPool = [...dedupe(sameCity), ...dedupe(rest)]
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

/** Escape ILIKE wildcards so a free-text value matches literally. */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}
