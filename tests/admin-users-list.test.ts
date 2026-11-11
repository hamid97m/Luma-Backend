import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('GET /admin/users', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const list = async (qs = '') => {
    const res = await app.inject({ method: 'GET', url: `/admin/users${qs}`, headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const names = (body: any) => body.items.map((i: any) => i.name).sort()

  it('search matches email', async () => {
    await createUser({ name: 'Web', telegram_id: null, email: 'zed@example.com', google_sub: 'g-1' })
    await createUser({ name: 'Other' })
    const body = await list('?query=zed@exam')
    expect(names(body)).toEqual(['Web'])
    expect(body.items[0]).toMatchObject({ telegramId: null, email: 'zed@example.com', signInMethods: ['google'] })
  })

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users' })
    expect(res.statusCode).toBe(401)
  })

  it('returns camelCase items with pagination math, newest first', async () => {
    // 42 users → 3 pages of 20; page 2 holds the 21st..40th newest.
    const base = Date.parse('2026-08-01T00:00:00Z')
    for (let i = 0; i < 41; i++) {
      await createUser({ name: `Filler ${i}`, created_at: new Date(base + i * 60_000).toISOString() })
    }
    const sara = await createUser({
      telegram_id: 42, username: 'sara', name: 'Sara', age: 24, gender: 'woman', looking_for: 'men',
      is_active: true, is_seed: false, account_status: 'preparing',
      created_at: '2026-07-01T00:00:00Z', last_active: '2026-08-04T00:00:00Z',
      geo_city: 'Tehran', geo_country: 'IR',
    })

    const body = await list('?page=3')

    expect(body.total).toBe(42)
    expect(body.page).toBe(3)
    expect(body.pageCount).toBe(3)
    expect(body.items).toHaveLength(2)
    expect(body.items[1]).toEqual({
      id: sara.id, telegramId: 42, email: null, signInMethods: ['telegram'], username: 'sara', name: 'Sara', age: 24,
      gender: 'woman', lookingFor: 'men', isActive: true, isSeed: false, bannedAt: null, pausedAt: null,
      deletedAt: null, createdAt: '2026-07-01T00:00:00.000Z', lastActive: '2026-08-04T00:00:00.000Z',
      geoCity: 'Tehran', geoCountry: 'IR', locale: null, accountStatus: 'preparing',
      joinTag: null, botStatus: null, botStatusAt: null,
    })

    const page2 = await list('?page=2')
    expect(page2.items).toHaveLength(20)
    expect(page2.items[0].name).toBe('Filler 20')
  })

  it('returns an empty page when nothing matches', async () => {
    await createUser({ name: 'Sara' })
    expect(await list('?query=sara&status=banned&page=1')).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it('applies the status filters (admins still see deleted users)', async () => {
    const now = new Date().toISOString()
    await createUser({ name: 'Active', account_status: 'active' })
    await createUser({ name: 'Preparing', account_status: 'preparing' })
    await createUser({ name: 'Banned', banned_at: now })
    await createUser({ name: 'Deleted', deleted_at: now })
    await createUser({ name: 'Seed', is_seed: true, telegram_id: -5 })

    expect(names(await list())).toEqual(['Active', 'Banned', 'Deleted', 'Preparing', 'Seed'])
    expect(names(await list('?status=active'))).toEqual(['Active', 'Seed'])
    expect(names(await list('?status=preparing'))).toEqual(['Preparing'])
    expect(names(await list('?status=banned'))).toEqual(['Banned'])
    expect(names(await list('?status=deleted'))).toEqual(['Deleted'])
    expect(names(await list('?status=seed'))).toEqual(['Seed'])
  })

  it('filters by gender and ignores an unknown gender', async () => {
    await createUser({ name: 'Ali', gender: 'man' })
    await createUser({ name: 'Sara', gender: 'woman' })
    expect(names(await list('?gender=woman'))).toEqual(['Sara'])
    expect(names(await list('?gender=robot'))).toEqual(['Ali', 'Sara'])
  })

  it('searches name/username case-insensitively, and telegram_id for numeric terms', async () => {
    await createUser({ name: 'Sara Ahmadi', username: 'sa' })
    await createUser({ name: 'Ali', username: 'SARAfan' })
    await createUser({ name: 'Reza', telegram_id: 777 })
    await createUser({ name: 'Mina' })

    expect(names(await list('?query=sara'))).toEqual(['Ali', 'Sara Ahmadi'])
    expect(names(await list('?query=777'))).toEqual(['Reza'])
    expect(names(await list('?query=' + encodeURIComponent('  sara  ahmadi ')))).toEqual(['Sara Ahmadi'])
  })

  it('keeps % and _ (and *) as wildcards in the search term', async () => {
    await createUser({ name: 'Sara' })
    await createUser({ name: 'Sima' })
    expect(names(await list('?query=' + encodeURIComponent('s%a')))).toEqual(['Sara', 'Sima'])
    expect(names(await list('?query=' + encodeURIComponent('s_ra')))).toEqual(['Sara'])
    expect(names(await list('?query=' + encodeURIComponent('s*a')))).toEqual(['Sara', 'Sima'])
  })

  it('sanitizes filter-structural characters and binds the term (no injection)', async () => {
    await createUser({ name: 'a id.neq.123 x' })
    await createUser({ name: 'Other' })

    const body = await list('?query=' + encodeURIComponent('a,id.neq.123(x)'))
    expect(names(body)).toEqual(['a id.neq.123 x'])

    const evil = await list('?query=' + encodeURIComponent("' or 1=1 --"))
    expect(evil.total).toBe(0)
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(2)
  })

  it('returns 500 on a database error (out-of-range telegram_id search)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users?query=99999999999999999999999', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'users_fetch_failed' })
  })
})
