import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ getBotUsername: () => 'lumabot' }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/referrals/attribution.js', () => ({ captureReferralAttribution: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { withFailingWrites } from './helpers/profile.js'

const localeOf = async (id: string) => (await sql`select locale from users where id = ${id}`)[0].locale

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
beforeEach(async () => {
  vi.mocked(verifyInitData).mockReset()
  await resetDb()
  app = await buildApp()
})

describe('GET /profile/me — locale', () => {
  it('selects and returns the stored locale', async () => {
    me = await createUser({ locale: 'en' })
    authAs(me)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json().locale).toBe('en')
  })

  it('returns locale: null for a user who has not picked a language yet', async () => {
    me = await createUser({ locale: null })
    authAs(me)

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('locale', null)
  })
})

describe('PUT /profile/me — locale', () => {
  beforeEach(async () => { me = await createUser({ locale: 'fa' }); authAs(me) })

  it('writes a valid locale and returns it', async () => {
    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 'ar' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().locale).toBe('ar')
    expect(await localeOf(me.id)).toBe('ar')
  })

  it('rejects an unknown locale with 400 invalid_locale and writes nothing', async () => {
    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 'de' } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
    expect(await localeOf(me.id)).toBe('fa')
  })

  it('rejects a non-string locale with 400 invalid_locale', async () => {
    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 1 } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
  })
})

describe('PATCH /profile/me/locale', () => {
  beforeEach(async () => { me = await createUser({ locale: 'fa' }); authAs(me) })

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/profile/me/locale', headers: AUTH, payload })

  it('stores a valid locale', async () => {
    const other = await createUser({ locale: 'fa' })

    const res = await patch({ locale: 'en' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, locale: 'en' })
    expect(await localeOf(me.id)).toBe('en')
    expect(await localeOf(other.id)).toBe('fa')
  })

  it('rejects an unknown locale and writes nothing', async () => {
    const res = await patch({ locale: 'de' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
    expect(await localeOf(me.id)).toBe('fa')
  })

  it('rejects a missing locale', async () => {
    const res = await patch({})

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
  })

  it('returns 500 update_failed when the write fails', async () => {
    // The auth preHandler's last_active refresh is fire-and-forget; a fresh
    // last_active keeps it from firing so only the route's update hits the trigger.
    const res = await withFailingWrites('users', 'update', () => patch({ locale: 'fa' }))

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', payload: { locale: 'en' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /auth/verify — locale', () => {
  const verify = () => app.inject({ method: 'POST', url: '/auth/verify', payload: { initData: 'valid_init_data' } })

  it('returns locale: null for a brand-new user so the client shows the language picker', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)

    const res = await verify()

    expect(res.statusCode).toBe(200)
    const [created] = await sql`select id from users where telegram_id = 42`
    expect(res.json().user).toEqual({ id: created.id, name: 'Hamid', setupComplete: false, locale: null })
  })

  it('returns the stored locale for an existing user who has not finished setup', async () => {
    const u = await createUser({ telegram_id: 42, name: 'Hamid', age: 0, locale: 'en' })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)

    const res = await verify()

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toEqual({ id: u.id, name: 'Hamid', setupComplete: false, locale: 'en' })
  })

  it('returns the stored locale for an existing user with a complete profile', async () => {
    const u = await createUser({ telegram_id: 42, name: 'Hamid', age: 25, locale: 'ar' })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)

    const res = await verify()

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: u.id, setupComplete: true, locale: 'ar' })
  })
})
