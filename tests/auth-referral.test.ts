import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  verifyInitData: vi.fn(),
}))
// Referrals area — only the call into it is under test here.
vi.mock('../src/referrals/attribution.js', () => ({
  captureReferralAttribution: vi.fn().mockResolvedValue(undefined),
}))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { captureReferralAttribution } from '../src/referrals/attribution.js'
import { resetDb, createUser, sql } from './helpers/db.js'

describe('POST /auth/verify referral attribution', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    app = await buildApp()
  })

  it('captures attribution for a brand-new user with a ref start_param', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'start_param=ref_x9km2pqr&auth_date=123' },
    })

    expect(res.statusCode).toBe(200)
    const [created] = await sql`select id from users where telegram_id = 42`
    expect(captureReferralAttribution).toHaveBeenCalledWith(created.id, 42, 'ref_x9km2pqr')
  })

  it('does not capture attribution for an existing user', async () => {
    await createUser({ telegram_id: 42, name: 'Hamid', age: 25 })
    vi.mocked(verifyInitData).mockReturnValue({ id: 42, first_name: 'Hamid', username: 'hamid' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { initData: 'start_param=ref_x9km2pqr&auth_date=123' },
    })

    expect(res.statusCode).toBe(200)
    expect(captureReferralAttribution).not.toHaveBeenCalled()
  })
})
