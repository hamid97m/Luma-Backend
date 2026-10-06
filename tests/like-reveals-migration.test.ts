import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = () => readFileSync(
  resolve(import.meta.dirname, '../../supabase/migrations/20261007120000_add_like_reveals.sql'),
  'utf8',
)

describe('like_reveals migration', () => {
  it('stores one reveal per woman per day and locks it to service_role', () => {
    const text = sql().toLowerCase()
    expect(text).toContain('create table like_reveals')
    expect(text).toContain('primary key (user_id, revealed_on)')
    expect(text).toContain('revealed_on date not null')
    expect(text).toContain('notified_at timestamptz')
    expect(text).toContain('grant all on like_reveals to service_role')
    expect(text).toContain('revoke all on like_reveals from anon, authenticated')
    expect(text).toContain('enable row level security')
  })
})
