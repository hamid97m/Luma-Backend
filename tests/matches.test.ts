import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('GET /matches', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns list of matches with other user info', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        or: () => ({
          order: () => ({
            data: [{
              id: 'match-1',
              created_at: '2026-01-01T00:00:00Z',
              user1_id: USER_ID,
              user2_id: 'other-user',
              users: { id: 'other-user', name: 'Sara', telegram_id: 99 },
            }],
            error: null,
          }),
        }),
      }),
    } as any)

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        eq: () => ({ order: () => ({ data: [{ url: 'https://img', position: 0 }], error: null }) }),
      }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.matches).toHaveLength(1)
    expect(body.matches[0].user.name).toBe('Sara')
    expect(body.matches[0].user.telegramId).toBe(99)
  })
})
