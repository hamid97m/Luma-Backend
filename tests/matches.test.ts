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

function mockMatchesRow() {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      or: () => ({
        order: () => ({
          data: [{
            id: 'match-1',
            created_at: '2026-01-01T00:00:00Z',
            user1_id: USER_ID,
            user2_id: 'other-user',
            user1: { id: USER_ID, name: 'Ali', telegram_id: 1, deleted_at: null, age: 30, bio: null, icebreaker_prompt: null, icebreaker_answer: null },
            user2: { id: 'other-user', name: 'Sara', telegram_id: 99, deleted_at: null, age: 24, bio: 'Coffee person', icebreaker_prompt: 'My perfect Sunday', icebreaker_answer: 'Hiking then pancakes' },
          }],
          error: null,
        }),
      }),
    }),
  } as any)
}

function mockPhotos() {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      eq: () => ({ order: () => ({ data: [{ url: 'https://img', position: 0 }], error: null }) }),
    }),
  } as any)
}

function mockLastMessage(row: { body: string; created_at: string; sender_id: string } | null) {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => ({ data: row ? [row] : [], error: null }),
        }),
      }),
    }),
  } as any)
}

function mockUnreadCount(count: number) {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({
      eq: () => ({
        neq: () => ({
          is: () => ({ count, error: null }),
        }),
      }),
    }),
  } as any)
}

describe('GET /matches', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns list of matches with other user info, last message, and unread count', async () => {
    setupAuth()
    mockMatchesRow()
    mockPhotos()
    mockLastMessage({ body: 'hey there', created_at: '2026-01-02T00:00:00Z', sender_id: 'other-user' })
    mockUnreadCount(2)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.matches).toHaveLength(1)
    expect(body.matches[0].user.name).toBe('Sara')
    expect(body.matches[0].user.telegramId).toBe(99)
    expect(body.matches[0].user.age).toBe(24)
    expect(body.matches[0].user.bio).toBe('Coffee person')
    expect(body.matches[0].user.icebreakerPrompt).toBe('My perfect Sunday')
    expect(body.matches[0].user.icebreakerAnswer).toBe('Hiking then pancakes')
    expect(body.matches[0].lastMessage).toEqual({
      body: 'hey there', createdAt: '2026-01-02T00:00:00Z', senderId: 'other-user',
    })
    expect(body.matches[0].unreadCount).toBe(2)
  })

  it('returns null lastMessage and 0 unreadCount when there are no messages yet', async () => {
    setupAuth()
    mockMatchesRow()
    mockPhotos()
    mockLastMessage(null)
    mockUnreadCount(0)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })

    const body = res.json()
    expect(body.matches[0].lastMessage).toBeNull()
    expect(body.matches[0].unreadCount).toBe(0)
  })

  it('excludes a match whose counterpart has deleted their account', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        or: () => ({
          order: () => ({
            data: [{
              id: 'match-1',
              created_at: '2026-01-01T00:00:00Z',
              user1_id: USER_ID,
              user2_id: 'deleted-user',
              user1: { id: USER_ID, name: 'Ali', telegram_id: 1, deleted_at: null },
              user2: { id: 'deleted-user', name: '', telegram_id: 99, deleted_at: '2026-07-30T00:00:00Z' },
            }],
            error: null,
          }),
        }),
      }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json().matches).toHaveLength(0)
  })
})

describe('GET /matches/unread-count', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/unread-count' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the aggregate unread count across active matches', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        or: () => ({
          data: [{
            id: 'match-1', user1_id: USER_ID, user2_id: 'other-user',
            user1: { deleted_at: null }, user2: { deleted_at: null },
          }],
          error: null,
        }),
      }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ neq: () => ({ is: () => ({ count: 3, error: null }) }) }) }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/matches/unread-count', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 3 })
  })

  it('excludes deleted-counterpart matches from the count query', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({
        or: () => ({
          data: [
            { id: 'match-1', user1_id: USER_ID, user2_id: 'other-1', user1: { deleted_at: null }, user2: { deleted_at: null } },
            { id: 'match-2', user1_id: USER_ID, user2_id: 'other-2', user1: { deleted_at: null }, user2: { deleted_at: '2026-07-30T00:00:00Z' } },
          ],
          error: null,
        }),
      }),
    } as any)

    const inSpy = vi.fn(() => ({ neq: () => ({ is: () => ({ count: 1, error: null }) }) }))
    vi.mocked(db.from).mockReturnValueOnce({ select: () => ({ in: inSpy }) } as any)

    const res = await app.inject({ method: 'GET', url: '/matches/unread-count', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 1 })
    expect(inSpy).toHaveBeenCalledWith('match_id', ['match-1'])
  })

  it('returns 0 without querying messages when there are no active matches', async () => {
    setupAuth()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ or: () => ({ data: [], error: null }) }),
    } as any)

    const res = await app.inject({ method: 'GET', url: '/matches/unread-count', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0 })
  })
})
