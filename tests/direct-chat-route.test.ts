import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/premium/directChatLimit.js', () => ({ checkAndCountDirectChat: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { checkAndCountDirectChat } from '../src/premium/directChatLimit.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000002'
const MATCH_ID = 'cccccccc-0000-0000-0000-000000000003'
const RESET_AT = '2026-09-06T12:00:00.000Z'
const TARGET_ROW = { id: TARGET_ID, name: 'Sara', telegram_id: 99, username: 'sara', deleted_at: null }

// Auth preHandler looks up the caller by init-data id → { id: USER_ID }.
function mockAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}
const mockTarget = (row: any = TARGET_ROW) =>
  vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: row }) }) }) } as any)
const mockBlocks = (rows: any[] = []) =>
  vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ or: () => ({ data: rows }) }) } as any)
const mockExistingMatch = (id: string | null) =>
  vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => ({ data: id ? { id } : null }) }) }) }) } as any)
const mockInsertMatch = (id: string) =>
  vi.mocked(db.from).mockReturnValueOnce({ insert: () => ({ select: () => ({ maybeSingle: () => ({ data: { id }, error: null }) }) }) } as any)

function post() {
  return app.inject({ method: 'POST', url: '/discovery/direct-chat', headers: AUTH, payload: { targetUserId: TARGET_ID } })
}

let app: Awaited<ReturnType<typeof buildApp>>
beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

describe('POST /discovery/direct-chat', () => {
  it('creates a match for a free woman and returns created:true', async () => {
    mockAuth(); mockTarget(); mockBlocks(); mockExistingMatch(null); mockInsertMatch(MATCH_ID)
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'free' } as any)
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: true, match: { id: MATCH_ID, user: { id: TARGET_ID, name: 'Sara', telegramId: 99, username: 'sara' } } })
  })

  it('returns the existing match without consuming quota', async () => {
    mockAuth(); mockTarget(); mockBlocks(); mockExistingMatch(MATCH_ID)
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: false, match: { id: MATCH_ID, user: { id: TARGET_ID, name: 'Sara', telegramId: 99, username: 'sara' } } })
    expect(checkAndCountDirectChat).not.toHaveBeenCalled()
  })

  it('403 premium_required for a non-premium cohort man', async () => {
    mockAuth(); mockTarget(); mockBlocks(); mockExistingMatch(null)
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'paywall' } as any)
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'premium_required' })
  })

  it('403 direct_chat_limit with resetAt when the daily cap is hit', async () => {
    mockAuth(); mockTarget(); mockBlocks(); mockExistingMatch(null)
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'quota', blocked: true, resetAt: RESET_AT } as any)
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'direct_chat_limit', resetAt: RESET_AT })
  })

  it('creates a match for a premium man under the cap', async () => {
    mockAuth(); mockTarget(); mockBlocks(); mockExistingMatch(null); mockInsertMatch(MATCH_ID)
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'quota', blocked: false, remaining: 2, resetAt: RESET_AT } as any)
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: true, match: { id: MATCH_ID, user: { id: TARGET_ID, name: 'Sara', telegramId: 99, username: 'sara' } }, directChat: { remaining: 2, resetAt: RESET_AT } })
  })

  it('404 when the target is missing/deleted', async () => {
    mockAuth(); mockTarget(null)
    const res = await post()
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('403 blocked when a block exists in either direction', async () => {
    mockAuth(); mockTarget(); mockBlocks([{ id: 'blk' }])
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'blocked' })
  })

  it('400 when targeting self', async () => {
    mockAuth()
    const res = await app.inject({ method: 'POST', url: '/discovery/direct-chat', headers: AUTH, payload: { targetUserId: USER_ID } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_target' })
  })
})
