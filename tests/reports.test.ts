import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'reporter-1'
const REPORTED_ID = 'reported-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  // auth preHandler: users lookup by telegram_id
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /reports', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('creates a discovery report and a block row', async () => {
    setupAuth()
    const insert = vi.fn(() => ({ error: null }))
    const upsert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: REPORTED_ID } }) }) }) } as any) // reported exists
      .mockReturnValueOnce({ insert } as any)   // reports
      .mockReturnValueOnce({ upsert } as any)   // blocks

    const res = await app.inject({
      method: 'POST', url: '/reports', headers: AUTH,
      payload: { reportedUserId: REPORTED_ID, context: 'discovery', reason: 'fake' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((insert.mock.calls[0][0] as any)).toMatchObject({
      reporter_id: USER_ID, reported_id: REPORTED_ID, context: 'discovery', reason: 'fake', status: 'pending',
    })
    expect((upsert.mock.calls[0][0] as any)).toMatchObject({ blocker_id: USER_ID, blocked_id: REPORTED_ID })
  })

  it('rejects reporting yourself', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: '/reports', headers: AUTH,
      payload: { reportedUserId: USER_ID, context: 'discovery', reason: 'fake' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'cannot_report_self' })
  })

  it('rejects an invalid reason', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: '/reports', headers: AUTH,
      payload: { reportedUserId: REPORTED_ID, context: 'discovery', reason: 'nonsense' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_report' })
  })

  it('is idempotent when a pending report already exists', async () => {
    setupAuth()
    const insert = vi.fn(() => ({ error: { code: '23505', message: 'duplicate key' } }))
    const upsert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: REPORTED_ID } }) }) }) } as any)
      .mockReturnValueOnce({ insert } as any)
      .mockReturnValueOnce({ upsert } as any)

    const res = await app.inject({
      method: 'POST', url: '/reports', headers: AUTH,
      payload: { reportedUserId: REPORTED_ID, context: 'discovery', reason: 'spam' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('ignores a matchId the reporter is not part of (stores null)', async () => {
    setupAuth()
    const insert = vi.fn(() => ({ error: null }))
    const upsert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: REPORTED_ID } }) }) }) } as any) // reported exists
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { user1_id: 'x', user2_id: 'y' } }) }) }) } as any) // match, not a participant
      .mockReturnValueOnce({ insert } as any)
      .mockReturnValueOnce({ upsert } as any)

    const res = await app.inject({
      method: 'POST', url: '/reports', headers: AUTH,
      payload: { reportedUserId: REPORTED_ID, context: 'chat', reason: 'harassment', matchId: 'match-9' },
    })
    expect(res.statusCode).toBe(200)
    expect((insert.mock.calls[0][0] as any).match_id).toBeNull()
  })
})
