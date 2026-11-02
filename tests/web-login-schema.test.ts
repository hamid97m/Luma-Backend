import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, insertRow, sql } from './helpers/db.js'

const base = { name: 'Web User', age: 28, gender: 'man', looking_for: 'women' }

describe('web-login schema', () => {
  beforeEach(async () => { await resetDb() })

  it('inserts a user with only email', async () => {
    const u = await insertRow('users', { ...base, email: 'a@example.com' })
    expect(u.telegram_id).toBeNull()
    expect(u.email).toBe('a@example.com')
  })

  it('inserts a user with only google_sub', async () => {
    const u = await insertRow('users', { ...base, google_sub: 'g-123' })
    expect(u.telegram_id).toBeNull()
    expect(u.google_sub).toBe('g-123')
  })

  it('rejects a user with no identity', async () => {
    await expect(insertRow('users', { ...base })).rejects.toThrow(/users_has_identity/)
  })

  it('rejects duplicate email', async () => {
    await insertRow('users', { ...base, email: 'dup@example.com' })
    await expect(insertRow('users', { ...base, email: 'dup@example.com' })).rejects.toThrow(/users_email_key/)
  })

  it('has the email_login_codes table', async () => {
    await sql`insert into email_login_codes (email, code_hash, expires_at) values ('a@example.com', 'h', now())`
    const [row] = await sql`select attempts, consumed_at from email_login_codes`
    expect(row.attempts).toBe(0)
    expect(row.consumed_at).toBeNull()
  })
})
