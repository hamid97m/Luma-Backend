import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('banned user enforcement', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { await resetDb(); app = await buildApp() })

  it('rejects a banned user with account_banned', async () => {
    const u = await createUser({ banned_at: '2026-08-04T00:00:00Z' })
    authAs(u)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_banned', botUsername: null })
  })

  it('rejects a banned user on POST /auth/verify with account_banned', async () => {
    const u = await createUser({ name: 'Ali', age: 25, banned_at: '2026-08-04T00:00:00Z' })
    authAs(u)

    const res = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { initData: 'valid_init_data' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'account_banned', botUsername: null })
    // Rejected before any write: last_active untouched, no new row.
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(1)
  })
})
