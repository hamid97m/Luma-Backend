import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { notifyMatch } from '../src/bot.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000002'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

describe('POST /swipes — pass', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns matched: false and does not check for reverse', async () => {
    setupAuth()

    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'pass' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    expect(notifyMatch).not.toHaveBeenCalled()
  })
})

describe('POST /swipes — like with no reverse', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns matched: false', async () => {
    setupAuth()

    // upsert swipe OK
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
  })
})

describe('POST /swipes — liking someone previously passed on', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('upserts on the (swiper_id, swiped_id) pair instead of no-op-ing on conflict', async () => {
    setupAuth()

    const upsert = vi.fn().mockReturnValue({ error: null })
    vi.mocked(db.from).mockReturnValueOnce({ upsert } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    // A prior pass on this same pair must not cause the like to be silently
    // dropped — it has to overwrite the stored row so /discovery excludes them.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ swiper_id: USER_ID, swiped_id: TARGET_ID, direction: 'like' }),
      { onConflict: 'swiper_id,swiped_id' }
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
  })
})

describe('POST /swipes — mutual like', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('creates match and calls notifyMatch', async () => {
    setupAuth()

    // upsert swipe
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // reverse swipe found
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: { id: 'swipe-2' }, error: null }) }) }) }) }),
    } as any)
    // insert match
    vi.mocked(db.from).mockReturnValueOnce({
      insert: vi.fn().mockReturnValue({
        select: () => ({ single: () => ({ data: { id: 'match-uuid' }, error: null }) }),
      }),
    } as any)
    // fetch both users
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1 },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2 },
      ], error: null }) }),
    } as any)
    // fetch primary photos
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ order: () => ({ data: [
        { user_id: USER_ID, url: 'https://example.com/ali.jpg' },
        { user_id: TARGET_ID, url: 'https://example.com/sara.jpg' },
      ] }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().matched).toBe(true)
    expect(res.json().match.id).toBe('match-uuid')
    // Each participant is notified about the OTHER person.
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 1, matchName: 'Sara', matchPhoto: 'https://example.com/sara.jpg' },
      { telegramId: 2, matchName: 'Ali', matchPhoto: 'https://example.com/ali.jpg' },
    ])
  })
})
