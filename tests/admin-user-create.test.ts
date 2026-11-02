import { describe, it, expect, vi, beforeEach } from 'vitest'

// Cross-area: geo resolution calls DeepSeek; not under test here.
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))

import { buildApp } from '../src/server.js'
import { scheduleUserGeo } from '../src/geo/resolveCity.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

const VALID_BODY = {
  name: 'Seed Sara', age: 25, gender: 'woman', looking_for: 'men',
  bio: 'hello', interests: ['music'], location: 'Tehran',
  photos: ['https://p1.jpg', 'https://p2.jpg'],
}

describe('POST /admin/users', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  it('creates a seed user with negative telegram_id and inserts photos', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users', headers, payload: VALID_BODY })

    expect(res.statusCode).toBe(201)
    const { id } = res.json()
    const [u] = await sql`select * from users where id = ${id}`
    expect(u.telegram_id).toBeLessThan(0)
    expect(u.is_seed).toBe(true)
    expect(u.is_active).toBe(true)
    expect(u.account_status).toBe('active')
    expect(u.name).toBe('Seed Sara')
    expect(u.bio).toBe('hello')
    expect(u.interests).toEqual(['music'])
    expect(u.icebreaker_prompt).toBeNull()
    // Omitted language is Persian — current fake profiles are Iranian.
    expect(u.locale).toBe('fa')

    const photos = await sql`select user_id, url, position from user_photos order by position`
    expect(photos).toEqual([
      { user_id: id, url: 'https://p1.jpg', position: 0 },
      { user_id: id, url: 'https://p2.jpg', position: 1 },
    ])
    expect(scheduleUserGeo).toHaveBeenCalledWith(id, 'Tehran', expect.anything())
  })

  it('is preparing without photos, and accepts empty interests', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/users', headers,
      payload: { ...VALID_BODY, photos: [], interests: undefined },
    })
    expect(res.statusCode).toBe(201)
    const [u] = await sql`select account_status, interests from users where id = ${res.json().id}`
    expect(u).toEqual({ account_status: 'preparing', interests: [] })
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
  })

  it('stores an explicit language', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/users', headers,
      payload: { ...VALID_BODY, locale: 'en' },
    })

    expect(res.statusCode).toBe(201)
    const [u] = await sql`select locale from users where id = ${res.json().id}`
    expect(u.locale).toBe('en')
  })

  it('500 create_failed when the insert fails (telegram_id collision)', async () => {
    await createUser({ telegram_id: -1_700_000_000_000 })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const res = await app.inject({ method: 'POST', url: '/admin/users', headers, payload: VALID_BODY })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'create_failed' })
    } finally {
      now.mockRestore()
    }
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
  })

  it.each([
    [{ ...VALID_BODY, name: '  ' }, 'invalid_name'],
    [{ ...VALID_BODY, age: 15 }, 'invalid_age'],
    [{ ...VALID_BODY, gender: 'robot' }, 'invalid_gender'],
    [{ ...VALID_BODY, looking_for: 'aliens' }, 'invalid_looking_for'],
    [{ ...VALID_BODY, locale: 'de' }, 'invalid_locale'],
  ])('rejects invalid input %#', async (payload, error) => {
    const res = await app.inject({ method: 'POST', url: '/admin/users', headers, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(0)
  })
})
