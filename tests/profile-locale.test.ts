import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ getBotUsername: () => 'lumabot' }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/referrals/attribution.js', () => ({ captureReferralAttribution: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

const AUTH = { authorization: 'valid_init_data' }
const TG_USER = { id: 1, first_name: 'Ali' }
const USER_ID = 'user-uuid-1'

type Log = Array<{ method: string; args: unknown[] }>

// mockReset (not clearAllMocks) so queued mockReturnValueOnce values from a
// test that bailed early (400 before touching the DB) don't leak forward.
function resetMocks() {
  vi.mocked(db.from).mockReset()
  vi.mocked(verifyInitData).mockReset()
}

// The auth preHandler resolves req.userId with one `users` select; every
// route-level query after that goes through the same mocked `db.from`.
function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue(TG_USER as any)
  vi.mocked(db.from).mockReturnValueOnce(
    chainable({ data: { id: USER_ID, banned_at: null, deleted_at: null }, error: null }),
  )
}

const BASE_USER = {
  id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: null,
  interests: [], location: null, icebreaker_prompt: null, icebreaker_answer: null,
  is_active: true, paused_at: null,
}

function mockPhotos() {
  vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))
}

describe('GET /profile/me — locale', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { resetMocks(); app = await buildApp() })

  it('selects and returns the stored locale', async () => {
    setupAuth()
    const log: Log = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: { ...BASE_USER, locale: 'en' }, error: null }, log))
    mockPhotos()

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json().locale).toBe('en')
    const select = log.find((e) => e.method === 'select')
    expect(String(select?.args[0])).toMatch(/\blocale\b/)
  })

  it('returns locale: null for a user who has not picked a language yet', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: { ...BASE_USER, locale: null }, error: null }))
    mockPhotos()

    const res = await app.inject({ method: 'GET', url: '/profile/me', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('locale', null)
  })
})

describe('PUT /profile/me — locale', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { resetMocks(); app = await buildApp() })

  it('writes a valid locale and returns it', async () => {
    setupAuth()
    const log: Log = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: { ...BASE_USER, locale: 'ar' }, error: null }, log))
    mockPhotos()

    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 'ar' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().locale).toBe('ar')
    const update = log.find((e) => e.method === 'update')
    expect(update?.args[0]).toMatchObject({ locale: 'ar' })
    const select = log.find((e) => e.method === 'select')
    expect(String(select?.args[0])).toMatch(/\blocale\b/)
  })

  it('rejects an unknown locale with 400 invalid_locale and writes nothing', async () => {
    setupAuth()
    const log: Log = []
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null, error: null }, log))

    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 'de' } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
    expect(log.some((e) => e.method === 'update')).toBe(false)
  })

  it('rejects a non-string locale with 400 invalid_locale', async () => {
    setupAuth()

    const res = await app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: { locale: 1 } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
  })
})

describe('PATCH /profile/me/locale', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { resetMocks(); app = await buildApp() })

  it('stores a valid locale', async () => {
    setupAuth()
    const log: Log = []
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: null, error: null }, log))

    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', headers: AUTH, payload: { locale: 'en' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, locale: 'en' })
    expect(log.some((e) => e.method === 'update' && (e.args[0] as any).locale === 'en')).toBe(true)
    expect(log.some((e) => e.method === 'eq' && e.args[0] === 'id' && e.args[1] === USER_ID)).toBe(true)
  })

  it('rejects an unknown locale and writes nothing', async () => {
    setupAuth()
    const log: Log = []
    vi.mocked(db.from).mockImplementation(() => chainable({ data: null, error: null }, log))

    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', headers: AUTH, payload: { locale: 'de' } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
    expect(log.some((e) => e.method === 'update')).toBe(false)
  })

  it('rejects a missing locale', async () => {
    setupAuth()

    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', headers: AUTH, payload: {} })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_locale' })
  })

  it('returns 500 update_failed when the write fails', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: null, error: { message: 'boom' } }))

    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', headers: AUTH, payload: { locale: 'fa' } })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'update_failed' })
  })

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/profile/me/locale', payload: { locale: 'en' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /auth/verify — locale', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { resetMocks(); app = await buildApp() })

  it('returns locale: null for a brand-new user so the client shows the language picker', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)
    vi.mocked(db.from)
      .mockReturnValueOnce(chainable({ data: null, error: null })) // select existing → none
      .mockReturnValueOnce(chainable({ data: { id: 'uuid-1', name: 'Hamid' }, error: null })) // insert

    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { initData: 'valid_init_data' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toEqual({ id: 'uuid-1', name: 'Hamid', setupComplete: false, locale: null })
  })

  it('returns the stored locale for an existing user who has not finished setup', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)
    const log: Log = []
    vi.mocked(db.from)
      .mockReturnValueOnce(chainable({
        data: { id: 'uuid-1', name: 'Hamid', age: 0, gender: 'man', looking_for: 'women', bio: null, deleted_at: null, banned_at: null, locale: 'en' },
        error: null,
      }, log))
      .mockReturnValueOnce(chainable({ data: null, error: null })) // last_active update

    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { initData: 'valid_init_data' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toEqual({ id: 'uuid-1', name: 'Hamid', setupComplete: false, locale: 'en' })
    const select = log.find((e) => e.method === 'select')
    expect(String(select?.args[0])).toMatch(/\blocale\b/)
  })

  it('returns the stored locale for an existing user with a complete profile', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' } as any)
    vi.mocked(db.from)
      .mockReturnValueOnce(chainable({
        data: { id: 'uuid-1', name: 'Hamid', age: 25, gender: 'man', looking_for: 'women', bio: null, deleted_at: null, banned_at: null, locale: 'ar' },
        error: null,
      }))
      .mockReturnValueOnce(chainable({ data: null, error: null })) // last_active update
      .mockReturnValueOnce(chainable({ data: { ...BASE_USER, id: 'uuid-1', name: 'Hamid', locale: 'ar' }, error: null })) // getProfileWithPhotos users
      .mockReturnValueOnce(chainable({ data: [], error: null })) // photos

    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { initData: 'valid_init_data' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: 'uuid-1', setupComplete: true, locale: 'ar' })
  })
})
