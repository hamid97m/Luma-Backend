/**
 * Query-level fault injection for real-DB tests. Wraps the postgres.js `sql`
 * tag so a test can make specific queries reject (matched on their SQL text and
 * bound values) while everything else runs against the real database — the
 * postgres.js counterpart of the old "supabase resolves { error }" mocks.
 *
 * Usage (this module must not import src/db.js — it is loaded inside the mock):
 *   vi.mock('../src/db.js', async (orig) => {
 *     const m = await orig<typeof import('../src/db.js')>()
 *     const { withFaults } = await import('./helpers/sql-faults.js')
 *     return { ...m, sql: withFaults(m.sql) }
 *   })
 *   failQuery((text, values) => /from swipes/.test(text))
 *   afterEach(clearFaults)
 */
type Pred = (text: string, values: unknown[]) => boolean

const faults: Pred[] = []
const seen: Array<{ text: string; values: unknown[] }> = []
let paused = 0

export function failQuery(pred: Pred): void {
  faults.push(pred)
}

export function clearFaults(): void {
  faults.length = 0
  seen.length = 0
}

/** Run test-side queries (fixtures, assertions) with injection and recording off. */
export async function withoutFaults<T>(fn: () => Promise<T>): Promise<T> {
  paused++
  try {
    return await fn()
  } finally {
    paused--
  }
}

/** Top-level tagged queries run since the last `clearFaults()` (text normalised to single spaces). */
export function queriesRun(): ReadonlyArray<{ text: string; values: unknown[] }> {
  return seen
}

export function withFaults<T extends (...args: any[]) => any>(sql: T): T {
  return new Proxy(sql, {
    apply(target, thisArg, args) {
      const [strings, ...values] = args
      if (!paused && Array.isArray(strings) && 'raw' in strings) {
        const text = (strings as string[]).join('?').replace(/\s+/g, ' ').trim()
        seen.push({ text, values })
        if (faults.some((f) => f(text, values))) {
          return Promise.reject(Object.assign(new Error(`injected fault: ${text.slice(0, 60)}`), { code: 'XX000' }))
        }
      }
      return Reflect.apply(target, thisArg, args)
    },
  })
}
