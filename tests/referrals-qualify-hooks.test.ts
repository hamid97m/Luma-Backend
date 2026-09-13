import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ fetchTelegramProfilePhoto: vi.fn(), notifyReferralQualified: vi.fn(), notifyReferralReward: vi.fn() }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { fetchTelegramProfilePhoto } from '../src/bot.js'
import { maybeQualifyReferral } from '../src/referrals/rewards.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('referral qualification hooks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.mocked(maybeQualifyReferral).mockClear()
    app = await buildApp()
  })

  it('calls maybeQualifyReferral on a successful photo confirm', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => ({ data: [{ id: 'old-photo', position: 0 }], error: null }) }) }),
    } as any)

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({ data: null, error: null }),
    } as any)

    // Resume check: user was not paused, so the .not() guard yields no row.
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }) }),
    } as any)

    const PUBLIC_URL = 'https://supabase.example.com/public/profile-photos/user-uuid-1/new-uuid'
    vi.mocked(db.storage.from).mockReturnValue({
      getPublicUrl: () => ({ data: { publicUrl: PUBLIC_URL } }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: 'new-uuid' },
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(USER_ID)
  })

  it('does NOT call maybeQualifyReferral when photo confirm fails validation (max photos reached)', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => ({ data: new Array(6).fill({ id: 'x', position: 0 }), error: null }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: 'some-uuid' },
    })

    expect(res.statusCode).toBe(400)
    expect(maybeQualifyReferral).not.toHaveBeenCalled()
  })

  it('calls maybeQualifyReferral on a successful photo import from Telegram', async () => {
    setupAuth()

    // telegram_id lookup
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { telegram_id: 12345 } }) }) }),
    } as any)

    // existing photos
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
    } as any)

    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValueOnce({ buffer: Buffer.from(''), mime: 'image/jpeg' } as any)

    vi.mocked(db.storage.from).mockReturnValue({
      upload: () => Promise.resolve({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://supabase.example.com/public/profile-photos/user-uuid-1/x' } }),
    } as any)

    vi.mocked(db.from).mockReturnValueOnce({
      insert: () => ({ data: null, error: null }),
    } as any)

    // Resume check: user was not paused.
    vi.mocked(db.from).mockReturnValueOnce({
      update: () => ({ eq: () => ({ not: () => ({ select: () => ({ maybeSingle: () => ({ data: null }) }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/from-telegram',
      headers: AUTH,
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(USER_ID)
  })

  it('calls maybeQualifyReferral on a successful profile update', async () => {
    setupAuth()

    vi.mocked(db.from)
      .mockReturnValueOnce({
        update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: { id: USER_ID, name: 'Ali', age: 25, gender: 'man', looking_for: 'women', bio: 'سلام' }, error: null }) }) }) }),
      } as any)
      .mockReturnValueOnce({
        select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { bio: 'سلام' },
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(USER_ID)
  })

  it('does NOT call maybeQualifyReferral when profile update fails validation (invalid age)', async () => {
    setupAuth()

    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { age: 12 },
    })

    expect(res.statusCode).toBe(400)
    expect(maybeQualifyReferral).not.toHaveBeenCalled()
  })
})
