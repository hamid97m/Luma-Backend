import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp, isPausedExempt } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

describe('isPausedExempt', () => {
  it('allows only the photo-upload POSTs that lift a pause', () => {
    expect(isPausedExempt('POST', '/profile/me/photos/upload-url')).toBe(true)
    expect(isPausedExempt('POST', '/profile/me/photos/confirm')).toBe(true)
    expect(isPausedExempt('POST', '/profile/me/photos/from-telegram')).toBe(true)
    expect(isPausedExempt('POST', '/profile/me/photos/abc/replace')).toBe(true)
    expect(isPausedExempt('POST', '/profile/me/photos/confirm?x=1')).toBe(true)
  })

  it('blocks everything else, including other photo actions', () => {
    expect(isPausedExempt('GET', '/profile/me')).toBe(false)
    expect(isPausedExempt('GET', '/discovery')).toBe(false)
    expect(isPausedExempt('POST', '/swipes')).toBe(false)
    expect(isPausedExempt('POST', '/matches/m1/messages')).toBe(false)
    expect(isPausedExempt('DELETE', '/profile/me/photos/abc')).toBe(false)
    expect(isPausedExempt('PATCH', '/profile/me/photos/reorder')).toBe(false)
    expect(isPausedExempt('GET', '/profile/me/photos/confirm')).toBe(false)
  })
})

describe('paused user lock', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    vi.mocked(db.from).mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => ({
            data: { id: 'me-1', deleted_at: null, banned_at: null, paused_at: '2026-10-16T00:00:00Z', last_active: null },
          }),
        }),
      }),
    } as any))
  })

  it('rejects discovery, matches and chat with account_paused', async () => {
    for (const [method, url] of [
      ['GET', '/discovery'],
      ['GET', '/matches'],
      ['POST', '/swipes'],
      ['POST', '/matches/m1/messages'],
    ] as const) {
      const res = await app.inject({
        method, url,
        headers: { authorization: 'valid_init_data' },
        payload: method === 'GET' ? undefined : { body: 'hi', targetUserId: 'them', direction: 'like' },
      })
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toEqual({ error: 'account_paused' })
    }
    // Auth lookup only — no route-level queries.
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(4)
  })
})
