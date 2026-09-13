import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  verifyInitData: vi.fn(),
}))
vi.mock('../src/db.js', () => ({
  db: { from: vi.fn() },
}))
vi.mock('../src/referrals/attribution.js', () => ({
  captureReferralAttribution: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { captureReferralAttribution } from '../src/referrals/attribution.js'

describe('POST /auth/verify referral attribution', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('captures attribution for a brand-new user with a ref start_param', async () => {
    vi.mocked(verifyInitData).mockReturnValue({
      id: 42,
      first_name: 'Hamid',
      username: 'hamid',
    })

    const mockFrom = vi.mocked(db.from)
    // First call: select existing user → not found
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    } as any)
    // Second call: insert new user
    mockFrom.mockReturnValueOnce({
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-1', name: 'Hamid' }, error: null }) }),
      }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'start_param=ref_x9km2pqr&auth_date=123' },
    })

    expect(res.statusCode).toBe(200)
    expect(captureReferralAttribution).toHaveBeenCalledWith('uuid-1', 42, 'ref_x9km2pqr')
  })

  it('does not capture attribution for an existing user', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ data: null, error: null }) })
    const mockFrom = vi.mocked(db.from)
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({
        data: { id: 'uuid-1', name: 'Hamid', age: 25, gender: 'man', looking_for: 'women', bio: null, deleted_at: null },
        error: null,
      }) }) }),
    } as any)
    mockFrom.mockReturnValueOnce({ update: updateMock } as any)
    // setupComplete → full profile fetch
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({
        data: {
          id: 'uuid-1', name: 'Hamid', age: 25, gender: 'man', looking_for: 'women',
          bio: null, interests: [], location: null,
          icebreaker_prompt: null, icebreaker_answer: null, is_active: true,
        },
        error: null,
      }) }) }),
    } as any)
    mockFrom.mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'start_param=ref_x9km2pqr&auth_date=123' },
    })

    expect(res.statusCode).toBe(200)
    expect(captureReferralAttribution).not.toHaveBeenCalled()
  })
})
