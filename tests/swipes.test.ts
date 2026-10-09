import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/premium/swipeLimit.js', () => ({
  checkAndCountSwipe: vi.fn().mockResolvedValue({ blocked: false, swipeLimit: null }),
}))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { notifyMatch, notifyNewLike } from '../src/bot.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { icebreakerQuestion } from '../src/icebreakers/catalog.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const TARGET_ID = 'bbbbbbbb-0000-0000-0000-000000000002'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

// Target existence/soft-delete lookup — runs before every swipe is recorded.
function mockTarget(row: { id: string; deleted_at: string | null } | null = { id: TARGET_ID, deleted_at: null }) {
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: row, error: row ? null : { message: 'not found' } }) }) }),
  } as any)
}

describe('POST /swipes — pass', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('returns matched: false and does not check for reverse', async () => {
    setupAuth()
    mockTarget()

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
    mockTarget()

    // upsert swipe OK
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    // fetch pair (swiper + target) for the like-DM
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2, allows_write_to_pm: null },
      ], error: null }) }),
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

  it('DMs the liked user when a like does not match', async () => {
    setupAuth()
    mockTarget()

    // upsert swipe OK
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    // fetch pair (swiper + target) — the DM follows the TARGET's locale, not the swiper's
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null, locale: 'fa' },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2, allows_write_to_pm: null, locale: 'en' },
      ], error: null }) }),
    } as any)
    const res = await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    expect(notifyNewLike).toHaveBeenCalledWith(2, 'Ali', 'en')
  })

  it('does not DM a woman when she is liked', async () => {
    setupAuth()
    mockTarget()
    vi.mocked(db.from).mockReturnValueOnce({ upsert: vi.fn().mockReturnValue({ error: null }) } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null, locale: 'fa', gender: 'man' },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2, allows_write_to_pm: null, locale: 'en', gender: 'woman' },
      ], error: null }) }),
    } as any)
    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().matched).toBe(false)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('still DMs a man immediately', async () => {
    setupAuth()
    mockTarget()
    vi.mocked(db.from).mockReturnValueOnce({ upsert: vi.fn().mockReturnValue({ error: null }) } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Sara', telegram_id: 1, allows_write_to_pm: null, locale: 'fa', gender: 'woman' },
        { id: TARGET_ID, name: 'Ali', telegram_id: 2, allows_write_to_pm: null, locale: 'en', gender: 'man' },
      ], error: null }) }),
    } as any)
    await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })
    expect(notifyNewLike).toHaveBeenCalledWith(2, 'Sara', 'en')
  })

  it('passes a null locale for a liked user who has not picked a language yet', async () => {
    setupAuth()
    mockTarget()
    vi.mocked(db.from).mockReturnValueOnce({ upsert: vi.fn().mockReturnValue({ error: null }) } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null, locale: 'en' },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2, allows_write_to_pm: null, locale: null },
      ], error: null }) }),
    } as any)
    await app.inject({ method: 'POST', url: '/swipes', headers: AUTH, payload: { targetUserId: TARGET_ID, direction: 'like' } })
    expect(notifyNewLike).toHaveBeenCalledWith(2, 'Ali', null)
  })

  it('does not DM when the target has not granted bot write access', async () => {
    setupAuth()
    mockTarget()

    // upsert swipe OK
    vi.mocked(db.from).mockReturnValueOnce({
      upsert: vi.fn().mockReturnValue({ error: null }),
    } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    // fetch pair — target opted out of bot DMs
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null },
        { id: TARGET_ID, name: 'Sara', telegram_id: 2, allows_write_to_pm: false },
      ], error: null }) }),
    } as any)

    await app.inject({
      method: 'POST',
      url: '/swipes',
      headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(notifyNewLike).not.toHaveBeenCalled()
  })
})

describe('POST /swipes — liking someone previously passed on', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })

  it('upserts on the (swiper_id, swiped_id) pair instead of no-op-ing on conflict', async () => {
    setupAuth()
    mockTarget()

    const upsert = vi.fn().mockReturnValue({ error: null })
    vi.mocked(db.from).mockReturnValueOnce({ upsert } as any)
    // no reverse swipe
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: () => ({ data: null, error: null }) }) }) }) }),
    } as any)
    // fetch pair — target is a fake sentinel, so the DM lookup short-circuits before the photo query
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: [
        { id: USER_ID, name: 'Ali', telegram_id: 1, allows_write_to_pm: null },
        { id: TARGET_ID, name: 'Sara', telegram_id: -1, allows_write_to_pm: null },
      ], error: null }) }),
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
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  // Everything up to (and including) a successful match insert.
  function mockUpToMatch(matchResult: { data: any; error: any } = { data: { id: 'match-uuid' }, error: null }) {
    setupAuth()
    mockTarget()
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
        select: () => ({ single: () => matchResult }),
      }),
    } as any)
  }

  function mockUsersAndPhotos(users: any[]) {
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: users, error: null }) }),
    } as any)
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ order: () => ({ data: [
        { user_id: USER_ID, url: 'https://example.com/ali.jpg' },
        { user_id: TARGET_ID, url: 'https://example.com/sara.jpg' },
      ] }) }) }),
    } as any)
  }

  const like = () => app.inject({
    method: 'POST',
    url: '/swipes',
    headers: AUTH,
    payload: { targetUserId: TARGET_ID, direction: 'like' },
  })

  it('creates match and calls notifyMatch', async () => {
    mockUpToMatch()
    // fetch both users — the match DM goes to Sara, in Sara's language
    mockUsersAndPhotos([
      { id: USER_ID, name: 'Ali', telegram_id: 1, locale: 'fa' },
      { id: TARGET_ID, name: 'Sara', telegram_id: 2, locale: 'ar' },
    ])

    const res = await like()

    expect(res.statusCode).toBe(200)
    expect(res.json().matched).toBe(true)
    expect(res.json().match.id).toBe('match-uuid')
    // Only the OTHER user (the earlier liker, away from the app) is DM'd — the
    // active swiper already sees the match live in-app, so no self-notification.
    // Ali has no icebreaker → no question, but the button still opens the chat.
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 2, matchName: 'Ali', matchPhoto: 'https://example.com/ali.jpg', locale: 'ar', matchId: 'match-uuid', question: null },
    ])
    // The match path uses notifyMatch, not the new-like DM — no double notification.
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('seeds both icebreakers (earlier liker first) before responding', async () => {
    let seeded = false
    vi.mocked(seedIcebreakers).mockImplementationOnce(async () => {
      await new Promise((r) => setImmediate(r))
      seeded = true
    })
    mockUpToMatch()
    mockUsersAndPhotos([
      { id: USER_ID, name: 'Ali', telegram_id: 1, locale: 'fa' },
      { id: TARGET_ID, name: 'Sara', telegram_id: 2, locale: 'ar' },
    ])

    await like()

    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith('match-uuid', [TARGET_ID, USER_ID])
    expect(seeded).toBe(true)
  })

  it("DMs the swiper's question in the recipient's language when the swiper has an icebreaker", async () => {
    mockUpToMatch()
    mockUsersAndPhotos([
      { id: USER_ID, name: 'Ali', telegram_id: 1, locale: 'fa', icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: 'Hiking' },
      { id: TARGET_ID, name: 'Sara', telegram_id: 2, locale: 'ar', icebreaker_prompt: 'حقيقتان وكذبة…', icebreaker_answer: 'x' },
    ])

    await like()

    expect(notifyMatch).toHaveBeenCalledWith([
      expect.objectContaining({ matchId: 'match-uuid', question: icebreakerQuestion('My ideal Friday…', 'ar') }),
    ])
  })

  it('sends no question when the swiper has a prompt but a blank answer', async () => {
    mockUpToMatch()
    mockUsersAndPhotos([
      { id: USER_ID, name: 'Ali', telegram_id: 1, locale: 'fa', icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: '   ' },
      { id: TARGET_ID, name: 'Sara', telegram_id: 2, locale: 'en' },
    ])

    await like()

    expect(notifyMatch).toHaveBeenCalledWith([expect.objectContaining({ question: null })])
  })

  it('still seeds when the users lookup fails (minimal response path)', async () => {
    mockUpToMatch()
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ in: () => ({ data: null, error: { message: 'boom' } }) }),
    } as any)

    const res = await like()

    expect(res.json().matched).toBe(true)
    expect(seedIcebreakers).toHaveBeenCalledWith('match-uuid', [TARGET_ID, USER_ID])
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('does not seed on the 23505 already-matched race', async () => {
    mockUpToMatch({ data: null, error: { code: '23505' } })

    const res = await like()

    expect(res.json()).toEqual({ matched: false })
    expect(seedIcebreakers).not.toHaveBeenCalled()
  })
})

describe('POST /swipes — missing or soft-deleted target', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('404s target_not_found when the target does not exist, without recording the swipe', async () => {
    setupAuth()
    mockTarget(null)

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'target_not_found' })
    // auth + target lookup only — the swipes upsert never ran.
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(2)
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('404s target_not_found when the target is soft-deleted, without recording the swipe', async () => {
    setupAuth()
    mockTarget({ id: TARGET_ID, deleted_at: '2026-09-01T00:00:00Z' })

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: TARGET_ID, direction: 'like' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'target_not_found' })
    // auth + target lookup only — no upsert, no match, no DM to a dead account.
    expect(vi.mocked(db.from)).toHaveBeenCalledTimes(2)
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(notifyMatch).not.toHaveBeenCalled()
  })
})

describe('POST /swipes when paused', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { vi.clearAllMocks(); app = await buildApp() })

  it('blocks a paused user with 403 account_paused', async () => {
    vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
    // auth preHandler: user row carries paused_at
    vi.mocked(db.from).mockReturnValueOnce({
      select: () => ({ eq: () => ({ single: () => ({ data: { id: 'me-1', paused_at: '2026-08-31T00:00:00Z' } }) }) }),
    } as any)

    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH,
      payload: { targetUserId: 'them-1', direction: 'like' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'account_paused' })
  })
})
