import { describe, it, expect } from 'vitest'

describe('like_reveals in the Postgres schema', () => {
  it('keys one reveal per woman per day (the reveal insert relies on this conflict target)', async () => {
    const { sql: db } = await import('../src/db.js')
    const [row] = await db`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      where c.conrelid = 'like_reveals'::regclass and c.contype = 'p'`
    expect(row.def).toBe('PRIMARY KEY (user_id, revealed_on)')
  })
})
