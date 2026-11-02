import postgres from 'postgres'

/**
 * Plain Postgres client (postgres.js). Tagged templates are parameterised by
 * construction: ``sql`select * from users where id = ${id}` ``.
 *
 * Result types mirror what supabase-js/PostgREST returned, so callers that
 * moved over keep the same shapes:
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

/** PostgREST answered "no rows" for a malformed uuid filter; Postgres throws
 *  22P02 instead. Guard client-supplied ids with this to keep 404s as 404s. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Drop keys whose value is `undefined` — PostgREST silently ignored them (JSON
 *  has no undefined), postgres.js throws. Use for `sql(obj)` inserts/updates
 *  built from optional fields; never turn undefined into null (that would wipe
 *  columns on update). */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
