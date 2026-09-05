import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'blocker-1'
const TARGET_ID = 'target-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  // auth preHandler: users lookup by telegram_id
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /block', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/block', payload: { userId: TARGET_ID } })
    expect(res.statusCode).toBe(401)
  })

  it('upserts a block row and returns ok', async () => {
    setupAuth()
    const upsert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: TARGET_ID } }) }) }) } as any) // target exists
      .mockReturnValueOnce({ upsert } as any) // blocks

    const res = await app.inject({
      method: 'POST', url: '/block', headers: AUTH, payload: { userId: TARGET_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(upsert.mock.calls[0][0]).toMatchObject({ blocker_id: USER_ID, blocked_id: TARGET_ID })
  })

  it('rejects blocking yourself', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: '/block', headers: AUTH, payload: { userId: USER_ID },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'cannot_block_self' })
  })

  it('rejects a missing userId', async () => {
    setupAuth()
    const res = await app.inject({
      method: 'POST', url: '/block', headers: AUTH, payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_block' })
  })

  it('returns 404 when the target user does not exist', async () => {
    setupAuth()
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: null }) }) }) } as any) // target missing

    const res = await app.inject({
      method: 'POST', url: '/block', headers: AUTH, payload: { userId: TARGET_ID },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('is idempotent when the block already exists', async () => {
    setupAuth()
    const upsert = vi.fn(() => ({ error: null }))
    vi.mocked(db.from)
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: () => ({ data: { id: TARGET_ID } }) }) }) } as any)
      .mockReturnValueOnce({ upsert } as any)

    const res = await app.inject({
      method: 'POST', url: '/block', headers: AUTH, payload: { userId: TARGET_ID },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
