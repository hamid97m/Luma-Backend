import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ fetchTelegramProfilePhoto: vi.fn(), notifyReferralQualified: vi.fn(), notifyReferralReward: vi.fn() }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
// Background AI photo check (another area) — not under test here.
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/server.js'
import { fetchTelegramProfilePhoto } from '../src/bot.js'
import { maybeQualifyReferral } from '../src/referrals/rewards.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto } from './helpers/db.js'

describe('referral qualification hooks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ name: 'Ali' })
    authAs(me)
  })

  it('calls maybeQualifyReferral on a successful photo confirm', async () => {
    await createPhoto(me.id, 0)
    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: randomUUID() },
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(me.id)
  })

  it('does NOT call maybeQualifyReferral when photo confirm fails validation (max photos reached)', async () => {
    for (let i = 0; i < 6; i++) await createPhoto(me.id, i)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/confirm',
      headers: AUTH, payload: { photoId: randomUUID() },
    })

    expect(res.statusCode).toBe(400)
    expect(maybeQualifyReferral).not.toHaveBeenCalled()
  })

  it('calls maybeQualifyReferral on a successful photo import from Telegram', async () => {
    vi.mocked(fetchTelegramProfilePhoto).mockResolvedValueOnce({ buffer: Buffer.from('jpeg'), mime: 'image/jpeg' } as any)

    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/from-telegram',
      headers: AUTH,
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(me.id)
  })

  it('calls maybeQualifyReferral on a successful profile update', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: AUTH,
      payload: { bio: 'سلام' },
    })

    expect(res.statusCode).toBe(200)
    expect(maybeQualifyReferral).toHaveBeenCalledWith(me.id)
  })

  it('does NOT call maybeQualifyReferral when profile update fails validation (invalid age)', async () => {
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
