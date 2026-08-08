import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/premium/swipeLimit.js', () => ({ checkAndCountSwipe: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { checkAndCountSwipe } from '../src/premium/swipeLimit.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000002'
const RESET_AT = '2026-08-07T16:00:00.000Z'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /swipes — swipe limit', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('403s with swipe_limit and resetAt when blocked, without recording the swipe', async () => {
    setupAuth()
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: true, resetAt: RESET_AT })

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'pass' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'swipe_limit', resetAt: RESET_AT })
    expect(checkAndCountSwipe).toHaveBeenCalledWith(USER_ID)
    // db.from was called once for auth only — the swipes upsert never ran.
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(1)
  })

  it('includes swipeLimit in the response for a limited (but not blocked) user', async () => {
    setupAuth()
    vi.mocked(checkAndCountSwipe).mockResolvedValue({
      blocked: false, swipeLimit: { remaining: 0, resetAt: RESET_AT },
    })
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'pass' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
  })

  it('omits swipeLimit entirely for exempt users', async () => {
    setupAuth()
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: null })
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'pass' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
  })

  it('includes swipeLimit in the response for a like with no reverse swipe (no match)', async () => {
    setupAuth()
    vi.mocked(checkAndCountSwipe).mockResolvedValue({
      blocked: false, swipeLimit: { remaining: 0, resetAt: RESET_AT },
    })
    // swipes upsert
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // reverse-swipe select — no reverse like recorded
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null }) }) }) }) }),
    } as any)
    // fetch pair — target is a fake sentinel, so the like-DM lookup short-circuits
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null },
        { id: TARGET_ID, name: 'Sara', telegram_id: -1, allows_write_to_pm: null },
      ], error: null }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false, swipeLimit: { remaining: 0, resetAt: RESET_AT } })
  })
})
