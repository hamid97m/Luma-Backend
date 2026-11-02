import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp, isPausedExempt } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, sql } from './helpers/db.js'

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
    await resetDb()
    app = await buildApp()
  })

  it('rejects discovery, matches and chat with account_paused', async () => {
    const me = await createUser({ paused_at: '2026-10-16T00:00:00Z' })
    const them = await createUser({ gender: 'woman', looking_for: 'men' })
    const match = await createMatch(me.id, them.id)
    authAs(me)

    for (const [method, url] of [
      ['GET', '/discovery'],
      ['GET', '/matches'],
      ['POST', '/swipes'],
      ['POST', `/matches/${match.id}/messages`],
    ] as const) {
      const res = await app.inject({
        method, url,
        headers: AUTH,
        payload: method === 'GET' ? undefined : { body: 'hi', targetUserId: them.id, direction: 'like' },
      })
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toEqual({ error: 'account_paused' })
    }
    // Rejected in the preHandler — no route-level writes happened.
    expect((await sql`select count(*)::int as n from swipes`)[0].n).toBe(0)
    expect((await sql`select count(*)::int as n from messages`)[0].n).toBe(0)
  })
})
