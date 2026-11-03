import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
  getBotUsername: vi.fn().mockReturnValue('luma_bot'),
}))
vi.mock('../src/premium/swipeLimit.js', () => ({
  checkAndCountSwipe: vi.fn().mockResolvedValue({ blocked: false, swipeLimit: null }),
}))
// Another area's module.
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { notifyMatch, notifyNewLike } from '../src/bot.js'
import { checkAndCountSwipe } from '../src/premium/swipeLimit.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { icebreakerQuestion } from '../src/icebreakers/catalog.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, createMatch, sql } from './helpers/db.js'
import { like as likeRow, pass as passRow } from './helpers/discovery.js'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let target: Record<string, any>

beforeEach(async () => {
  await resetDb()
  vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: null })
  app = await buildApp()
  me = await createUser({ name: 'Ali', gender: 'man', looking_for: 'women', locale: 'fa' })
  target = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', locale: 'en' })
  authAs(me)
})

const swipe = (direction: string, targetUserId: string = target.id) =>
  app.inject({ method: 'POST', url: '/swipes', headers: AUTH, payload: { targetUserId, direction } })

const swipeRows = () => sql`select swiper_id, swiped_id, direction, created_at from swipes order by created_at`

describe('POST /swipes — pass', () => {
  it('returns matched: false, records the pass, and does not check for reverse', async () => {
    await likeRow(target, me) // even a reverse like doesn't match on a pass
    const res = await swipe('pass')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    expect(notifyMatch).not.toHaveBeenCalled()
    const [row] = await sql`select direction from swipes where swiper_id = ${me.id}`
    expect(row.direction).toBe('pass')
    expect((await sql`select count(*)::int as n from matches`)[0].n).toBe(0)
  })
})

describe('POST /swipes — like with no reverse', () => {
  it('returns matched: false and records the like', async () => {
    const res = await swipe('like')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    const rows = await swipeRows()
    expect(rows).toMatchObject([{ swiper_id: me.id, swiped_id: target.id, direction: 'like' }])
  })

  it('DMs a liked man in HIS locale, naming the liker', async () => {
    const sara = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', locale: 'fa' })
    const ali = await createUser({ name: 'Ali', gender: 'man', looking_for: 'women', locale: 'en' })
    authAs(sara)
    const res = await swipe('like', ali.id)
    expect(res.json()).toEqual({ matched: false })
    expect(notifyNewLike).toHaveBeenCalledWith(ali.telegram_id, 'Sara', 'en')
  })

  it('does not DM a woman when she is liked', async () => {
    const res = await swipe('like')
    expect(res.statusCode).toBe(200)
    expect(res.json().matched).toBe(false)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('passes a null locale for a liked user who has not picked a language yet', async () => {
    const reza = await createUser({ name: 'Reza', gender: 'man', looking_for: 'women', locale: null })
    await swipe('like', reza.id)
    expect(notifyNewLike).toHaveBeenCalledWith(reza.telegram_id, 'Ali', null)
  })

  it('does not DM when the target has not granted bot write access', async () => {
    const reza = await createUser({ gender: 'man', looking_for: 'women', allows_write_to_pm: false })
    await swipe('like', reza.id)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('does not DM a sentinel (non-positive telegram id) account', async () => {
    const fake = await createUser({ gender: 'man', looking_for: 'women', telegram_id: -77 })
    const res = await swipe('like', fake.id)
    expect(res.json()).toEqual({ matched: false })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })
})

describe('POST /swipes — liking someone previously passed on', () => {
  it('overwrites the stored pass on the (swiper_id, swiped_id) pair instead of no-op-ing', async () => {
    await passRow(me, target, { created_at: '2026-01-01T00:00:00.000Z' })
    const res = await swipe('like')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    // A prior pass must not cause the like to be silently dropped — it has to
    // overwrite the stored row (fresh created_at) so /discovery excludes them.
    const rows = await swipeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('like')
    expect(rows[0].created_at > '2026-01-02').toBe(true)
  })
})

describe('POST /swipes — mutual like', () => {
  beforeEach(async () => {
    await likeRow(target, me) // Sara liked Ali earlier
    await createPhoto(me.id, 1, { url: 'https://example.com/ali-2.jpg' })
    await createPhoto(me.id, 0, { url: 'https://example.com/ali.jpg' })
    await createPhoto(target.id, 0, { url: 'https://example.com/sara.jpg' })
  })

  const matchRow = async () => (await sql`select id, user1_id, user2_id from matches`)[0]

  it('creates the match (pair ordered) and DMs the other user in her language', async () => {
    await sql`update users set locale = 'ar' where id = ${target.id}`
    const res = await swipe('like')

    expect(res.statusCode).toBe(200)
    const m = await matchRow()
    expect([m.user1_id, m.user2_id]).toEqual([me.id, target.id].sort())
    expect(res.json()).toEqual({
      matched: true,
      match: { id: m.id, user: { id: target.id, name: 'Sara' } },
    })
    // Only the OTHER user (the earlier liker, away from the app) is DM'd — the
    // active swiper already sees the match live in-app. Ali has no icebreaker →
    // no question, but the button still opens the chat. Photo = Ali's position 0.
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: target.telegram_id, matchName: 'Ali', matchPhoto: 'https://example.com/ali.jpg', locale: 'ar', matchId: m.id, question: null },
    ])
    // The match path uses notifyMatch, not the new-like DM — no double notification.
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('sends a null photo when the swiper has none', async () => {
    await sql`delete from user_photos where user_id = ${me.id}`
    await swipe('like')
    expect(notifyMatch).toHaveBeenCalledWith([expect.objectContaining({ matchPhoto: null })])
  })

  it('skips the match DM when the other user refused bot writes', async () => {
    await sql`update users set allows_write_to_pm = false where id = ${target.id}`
    const res = await swipe('like')
    expect(res.json().matched).toBe(true)
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('seeds both icebreakers (earlier liker first) before responding', async () => {
    let seeded = false
    vi.mocked(seedIcebreakers).mockImplementationOnce(async () => {
      await new Promise((r) => setImmediate(r))
      seeded = true
    })
    await swipe('like')
    const m = await matchRow()
    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith(m.id, [target.id, me.id])
    expect(seeded).toBe(true)
  })

  it("DMs the swiper's question in the recipient's language when the swiper has an icebreaker", async () => {
    await sql`update users set icebreaker_prompt = 'My ideal Friday…', icebreaker_answer = 'Hiking' where id = ${me.id}`
    await sql`update users set locale = 'ar', icebreaker_prompt = 'حقيقتان وكذبة…', icebreaker_answer = 'x' where id = ${target.id}`
    await swipe('like')
    const m = await matchRow()
    expect(notifyMatch).toHaveBeenCalledWith([
      expect.objectContaining({ matchId: m.id, question: icebreakerQuestion('My ideal Friday…', 'ar') }),
    ])
  })

  it('sends no question when the swiper has a prompt but a blank answer', async () => {
    await sql`update users set icebreaker_prompt = 'My ideal Friday…', icebreaker_answer = '   ' where id = ${me.id}`
    await swipe('like')
    expect(notifyMatch).toHaveBeenCalledWith([expect.objectContaining({ question: null })])
  })

  it('still seeds and answers minimally when the users lookup fails', async () => {
    // The post-match users read throws (table briefly unavailable): the match
    // stands, the response falls back to the minimal shape, no DM.
    vi.mocked(seedIcebreakers).mockImplementationOnce(async () => {
      await sql`alter table user_photos rename to user_photos_away`
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await swipe('like')
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.matched).toBe(true)
      expect(body.match.user).toEqual({ id: target.id, name: '' })
      const m = (await sql`select id from matches`)[0]
      expect(body.match.id).toBe(m.id)
      expect(seedIcebreakers).toHaveBeenCalledWith(m.id, [target.id, me.id])
      expect(notifyMatch).not.toHaveBeenCalled()
    } finally {
      await sql`alter table user_photos_away rename to user_photos`
      errSpy.mockRestore()
    }
  })

  it('does not seed on the 23505 already-matched race', async () => {
    const [u1, u2] = [me.id, target.id].sort()
    await createMatch(u1, u2)
    const res = await swipe('like')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ matched: false })
    expect(seedIcebreakers).not.toHaveBeenCalled()
    expect((await sql`select count(*)::int as n from matches`)[0].n).toBe(1)
  })

  it('carries swipeLimit into the match response', async () => {
    vi.mocked(checkAndCountSwipe).mockResolvedValue({ blocked: false, swipeLimit: { remaining: 3, resetAt: 'r' } })
    const res = await swipe('like')
    expect(res.json()).toMatchObject({ matched: true, swipeLimit: { remaining: 3, resetAt: 'r' } })
  })
})

describe('POST /swipes — invalid requests', () => {
  it('400s cannot_swipe_self', async () => {
    const res = await swipe('like', me.id)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'cannot_swipe_self' })
  })

  it('404s target_not_found when the target does not exist, without recording the swipe', async () => {
    const res = await swipe('like', '00000000-0000-0000-0000-000000000000')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'target_not_found' })
    expect(await swipeRows()).toEqual([])
    expect(checkAndCountSwipe).not.toHaveBeenCalled()
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('404s (not 500) for a malformed target id', async () => {
    const res = await swipe('like', 'not-a-uuid')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'target_not_found' })
    expect(checkAndCountSwipe).not.toHaveBeenCalled()
  })

  it('404s target_not_found when the target is soft-deleted, without recording the swipe', async () => {
    await sql`update users set deleted_at = now() where id = ${target.id}`
    await likeRow(target, me)
    const res = await swipe('like')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'target_not_found' })
    // No upsert, no match, no DM to a dead account, no quota burnt.
    expect((await sql`select count(*)::int as n from swipes where swiper_id = ${me.id}`)[0].n).toBe(0)
    expect((await sql`select count(*)::int as n from matches`)[0].n).toBe(0)
    expect(checkAndCountSwipe).not.toHaveBeenCalled()
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('500s swipe_failed for an unknown direction (enum rejects it)', async () => {
    const res = await swipe('superlike')
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'swipe_failed' })
    expect(await swipeRows()).toEqual([])
  })
})

describe('POST /swipes when paused', () => {
  it('blocks a paused user with 403 account_paused', async () => {
    const paused = await createUser({ paused_at: '2026-08-31T00:00:00Z' })
    authAs(paused)
    const res = await swipe('like')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'account_paused' })
    expect(await swipeRows()).toEqual([])
  })
})
