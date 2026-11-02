import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
  getBotUsername: vi.fn().mockReturnValue('luma_bot'),
}))
vi.mock('../src/premium/swipeLimit.js', () => ({ checkAndCountSwipe: vi.fn() }))

import { buildApp } from '../src/server.js'
import { checkAndCountSwipe } from '../src/premium/swipeLimit.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const RESET_AT = '2026-08-07T16:00:00.000Z'

describe('POST /swipes — swipe limit', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let me: Record<string, any>
  let target: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ name: 'Ali' })
    // A sentinel (telegram_id < 0) target, so the like-DM lookup short-circuits.
    target = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', telegram_id: -1 })
    authAs(me)
  })

  const swipe = (direction: 'like' | 'pass') =>
    app.inject({ method: 'POST', url: '/swipes', headers: AUTH, payload: { targetUserId: target.id, direction } })
  const swipeCount = async () => (await sql`select count(*)::int as n from swipes`)[0].n

  it('403s with swipe_limit and resetAt when blocked, without recording the swipe', async () => {
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: true, resetAt: RESET_AT })
    const res = await swipe('pass')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'swipe_limit', resetAt: RESET_AT })
    expect(checkAndCountSwipe).toHaveBeenCalledWith(me.id)
    expect(await swipeCount()).toBe(0)
  })

  it('includes swipeLimit in the response for a limited (but not blocked) user', async () => {
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
    const res = await swipe('pass')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
    expect(await swipeCount()).toBe(1)
  })

  it('omits swipeLimit entirely for exempt users', async () => {
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: null })
    const res = await swipe('pass')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
  })

  it('includes swipeLimit in the response for a like with no reverse swipe (no match)', async () => {
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
    const res = await swipe('like')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
  })
})
