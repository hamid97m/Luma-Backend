import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withFailingWrite } from './helpers/admin-db-fault.js'

describe('DELETE /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let seed: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
    seed = await createUser({ telegram_id: -100, is_seed: true, name: 'Seed' })
  })

  const del = (id: string) => app.inject({ method: 'DELETE', url: `/admin/users/${id}`, headers })
  const row = async (id: string) => (await sql`select deleted_at, is_active from users where id = ${id}`)[0]

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/admin/users/${seed.id}` })
    expect(res.statusCode).toBe(401)
    expect((await row(seed.id)).deleted_at).toBeNull()
  })

  it('404s for an unknown user', async () => {
    const res = await del('00000000-0000-0000-0000-000000000000')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('404s (not 500) for a malformed id', async () => {
    const res = await del('nope')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('400s for a real (non-seed) user', async () => {
    const real = await createUser({ name: 'Real' })
    const res = await del(real.id)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_a_seed_user' })
    expect(await row(real.id)).toEqual({ deleted_at: null, is_active: true })
  })

  it('soft-deletes a seed user: sets deleted_at and is_active false', async () => {
    const res = await del(seed.id)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const after = await row(seed.id)
    expect(after.is_active).toBe(false)
    expect(Date.now() - Date.parse(after.deleted_at)).toBeLessThan(5_000)
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(1) // soft, not hard
  })

  it('500s when the update fails', async () => {
    const res = await withFailingWrite('users', 'update', () => del(seed.id))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'delete_failed' })
  })
})
