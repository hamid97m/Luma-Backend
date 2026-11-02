import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/premium/swipeLimit.js', () => ({
  getSwipeLimitStatus: vi.fn().mockResolvedValue({ limited: false, resetAt: null }),
}))
// Another area's module — only its pass-through into the feed is tested here.
vi.mock('../src/premium/directChatLimit.js', () => ({ getDirectChatStatus: vi.fn() }))
vi.mock('../src/likes/reveal.js', () => ({
  hiddenIncomingLikerIds: vi.fn().mockResolvedValue([]),
  ensureDailyReveal: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { getDirectChatStatus } from '../src/premium/directChatLimit.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser } from './helpers/db.js'

describe('GET /discovery — directChat gate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
  })

  it('includes the directChat gate object in the feed response', async () => {
    const me = await createUser({ gender: 'man', looking_for: 'women' })
    authAs(me)
    vi.mocked(getDirectChatStatus).mockResolvedValue({
      gate: 'quota',
      remaining: 2,
      limit: 3,
      resetAt: '2026-09-06T12:00:00.000Z',
    })

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(getDirectChatStatus).toHaveBeenCalledWith(me.id)
    expect(res.json().directChat).toEqual({
      gate: 'quota',
      remaining: 2,
      limit: 3,
      resetAt: '2026-09-06T12:00:00.000Z',
    })
  })
})
