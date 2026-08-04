import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'me-1'
const BLOCKED_ID = 'blocked-2'

describe('GET /matches excludes blocked participants', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('drops a match whose other user is blocked', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    vi.mocked(db.from)
      // auth preHandler
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }) } as any)
      // blocks lookup
      .mockReturnValueOnce({ select: () => ({ or: () => ({ data: [{ blocker_id: USER_ID, blocked_id: BLOCKED_ID }] }) }) } as any)
      // matches lookup
      .mockReturnValueOnce({ select: () => ({ or: () => ({ order: () => ({ data: [
        { id: 'm1', created_at: 'now', user1_id: USER_ID, user2_id: BLOCKED_ID,
          user1: { id: USER_ID, name: 'Ali', deleted_at: null },
          user2: { id: BLOCKED_ID, name: 'Sara', deleted_at: null } },
      ] }) }) }) } as any)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().matches).toEqual([])
  })
})
