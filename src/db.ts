import postgres from 'postgres'

/**
 * Plain Postgres client (postgres.js). Tagged templates are parameterised by
 * construction: ``sql`select * from users where id = ${id}` ``.
 *
 * Result types are normalised to JSON-friendly shapes the routes return as-is:
 *   - timestamptz / timestamp → ISO string ("2026-11-02T17:32:01.773Z")
 *   - date                    → "YYYY-MM-DD" string
 *   - int8 (telegram_id, count(*)) → number (all our values are < 2^53)
 *   - json/jsonb, arrays      → parsed JS values
 */
export const sql = postgres(process.env.DATABASE_URL ?? 'postgres://localhost:5432/luma', {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: 30,
  connection: { TimeZone: 'UTC' },
  onnotice: () => {},
  types: {
    int8: {
      to: 20,
      from: [20],
      serialize: (x: unknown) => String(x),
      parse: (x: string) => Number(x),
    },
    timestamp: {
      to: 1184,
      from: [1184, 1114],
      serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
      // Server text format with TimeZone=UTC: "2026-11-02 17:32:01.773+00"
      parse: (x: string) => new Date(x.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString(),
    },
    date: {
      to: 1082,
      from: [1082],
      serialize: (x: unknown) => String(x),
      parse: (x: string) => x,
    },
  },
})

export type Sql = typeof sql

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Postgres throws 22P02 for a malformed uuid. Guard client-supplied ids with
 *  this so a bad id answers "no rows" (404) instead of a 500. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Drop keys whose value is `undefined` — postgres.js throws on them, and an
 *  omitted optional field means "leave unchanged". Use for `sql(obj)` inserts/updates
 *  built from optional fields; never turn undefined into null (that would wipe
 *  columns on update). */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
