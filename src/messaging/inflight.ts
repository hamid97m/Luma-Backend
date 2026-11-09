/**
 * Registry of fire-and-forget message-notification work (new-message
 * delivery, the message_read clear push). Routes don't await it, so tests
 * call settleMessageWork() (resetDb does) before touching the database again:
 * otherwise a delivery still inside its claim transaction can deadlock with
 * the next test's TRUNCATE. No dependencies, so test helpers can import it.
 */
const pending = new Set<Promise<unknown>>()

export function trackMessageWork<T>(p: Promise<T>): Promise<T> {
  pending.add(p)
  const drop = () => { pending.delete(p) }
  p.then(drop, drop)
  return p
}

/** Resolves once all tracked work (including work started meanwhile) has settled. */
export async function settleMessageWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}
