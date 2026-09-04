import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/swipeLimit.js', () => ({
  getSwipeLimitStatus: vi.fn().mockResolvedValue({ limited: false, resetAt: null }),
}))
vi.mock('../src/premium/directChatLimit.js', () => ({ getDirectChatStatus: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { getDirectChatStatus } from '../src/premium/directChatLimit.js'
import { chainable } from './admin-helpers.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /discovery — directChat gate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('includes the directChat gate object in the feed response', async () => {
    setupAuth()

    // viewer lookup — looking_for/gender/location
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { looking_for: 'women', gender: 'man', location: null }, error: null }) }) }),
    } as any)
    // recent swipes — empty
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ or: () => ({ data: [], error: null }) }) }),
    } as any)
    // blocks — empty (both directions via .or())
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)
    // liker swipes — nobody has liked the viewer
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
    } as any)
    // tier-3 profiles query — chainable tolerates the full query-builder chain
    vi.mocked(db.from).mockReturnValueOnce(chainable({ data: [], error: null }))

    vi.mocked(getDirectChatStatus).mockResolvedValue({
      gate: 'quota',
      remaining: 2,
      limit: 3,
      resetAt: '2026-09-06T12:00:00.000Z',
    })

    const res = await app.inject({ method: 'GET', url: '/discovery', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(getDirectChatStatus).toHaveBeenCalledWith(USER_ID)
    expect(res.json().directChat).toEqual({
      gate: 'quota',
      remaining: 2,
      limit: 3,
      resetAt: '2026-09-06T12:00:00.000Z',
    })
  })
})
