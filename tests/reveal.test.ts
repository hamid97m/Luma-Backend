import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyNewLike: vi.fn().mockResolvedValue(undefined) }))

import { notifyNewLike } from '../src/bot.js'
import { ensureDailyReveal, hiddenIncomingLikerIds } from '../src/likes/reveal.js'
import { resetDb, createUser, createPhoto, createMatch, insertRow, sql } from './helpers/db.js'
import { like, pass, block } from './helpers/discovery.js'

const NOW = new Date('2026-10-07T10:00:00.000Z') // Tehran date 2026-10-07
const NEXT_DAY = new Date('2026-10-07T21:00:00.000Z') // Tehran 2026-10-08 00:30

let woman: Record<string, any>
/** name → user id */
const ids: Record<string, string> = {}

async function makeWoman(opts: Record<string, unknown> = {}) {
  woman = await createUser({
    name: 'Her', gender: 'woman', looking_for: 'men', geo_city: 'Tehran', locale: 'fa',
    allows_write_to_pm: true, ...opts,
  })
  return woman
}

async function addLiker(name: string, opts: { createdAt?: string; photos?: number; user?: Record<string, unknown> } = {}) {
  const u = await createUser({
    name, gender: 'man', looking_for: 'women', geo_city: 'Tehran',
    last_active: '2026-10-07T08:00:00.000Z', ...opts.user,
  })
  for (let i = 0; i < (opts.photos ?? 1); i++) await createPhoto(u.id, i)
  await like(u, woman, { created_at: opts.createdAt ?? '2026-10-01T00:00:00.000Z' })
  ids[name] = u.id
  return u
}

async function storeReveal(name: string, revealed_on: string, notified_at: string | null = '2026-10-06T14:30:00.000Z') {
  await insertRow('like_reveals', { user_id: woman.id, swiper_id: ids[name], revealed_on, notified_at })
}

const reveals = () =>
  sql`select swiper_id, revealed_on, notified_at from like_reveals where user_id = ${woman.id} order by revealed_on`
const nameOf = (id: string | null) => Object.keys(ids).find((k) => ids[k] === id) ?? id

/** Temporarily rename a table so every query touching it fails. */
async function withTableGone<T>(table: string, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`alter table ${table} rename to ${table}_away`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`alter table ${table}_away rename to ${table}`)
  }
}

beforeEach(async () => {
  await resetDb()
  for (const k of Object.keys(ids)) delete ids[k]
  vi.mocked(notifyNewLike).mockResolvedValue(undefined)
  await makeWoman()
})

const run = async (now = NOW) => {
  const r = await ensureDailyReveal(woman.id, now)
  return r.applies ? { applies: true, swiperId: nameOf(r.swiperId) } : r
}

describe('ensureDailyReveal', () => {
  it('does not apply to a man', async () => {
    await sql`update users set gender = 'man' where id = ${woman.id}`
    await addLiker('ali')
    await expect(run()).resolves.toEqual({ applies: false })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(await reveals()).toEqual([])
  })

  it('does not apply to a missing viewer row', async () => {
    await expect(ensureDailyReveal('00000000-0000-0000-0000-000000000000', NOW)).resolves.toEqual({ applies: false })
  })

  it('does not apply to a seed viewer and never writes like_reveals', async () => {
    await sql`update users set is_seed = true where id = ${woman.id}`
    await addLiker('ali')
    await expect(run()).resolves.toEqual({ applies: false })
    expect(await reveals()).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('throws when the viewer read errors (malformed id) instead of applying nothing', async () => {
    await addLiker('ali')
    await expect(ensureDailyReveal('woman-1', NOW)).rejects.toBeTruthy()
    expect(await reveals()).toEqual([])
  })

  it('throws when the latest reveal read errors and does not insert or DM', async () => {
    await addLiker('ali')
    await expect(withTableGone('like_reveals', () => ensureDailyReveal(woman.id, NOW))).rejects.toBeTruthy()
    expect(await reveals()).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('picks the eligible liker, stores the row, DMs once and stamps notified_at', async () => {
    await addLiker('ali', { user: { last_active: '2026-10-07T09:00:00.000Z' } })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    const rows = await reveals()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ swiper_id: ids.ali, revealed_on: '2026-10-07' })
    expect(rows[0].notified_at).not.toBeNull()
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(notifyNewLike).toHaveBeenCalledWith(woman.telegram_id, 'ali', 'fa')
  })

  it('prefers a same-city liker, then the more recently active one', async () => {
    await addLiker('shiraz', { user: { geo_city: 'Shiraz', last_active: '2026-10-07T09:59:00.000Z' } })
    await addLiker('tehran-old', { user: { last_active: '2026-10-07T01:00:00.000Z' } })
    await addLiker('tehran-new', { user: { last_active: '2026-10-07T05:00:00.000Z' } })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'tehran-new' })
  })

  it('returns the same person without a second DM', async () => {
    await addLiker('ali')
    await storeReveal('ali', '2026-10-07', '2026-10-07T09:00:00.000Z')
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(await reveals()).toHaveLength(1)
  })

  it('keeps an unanswered reveal from yesterday while he is still live', async () => {
    await addLiker('ali')
    await addLiker('reza')
    await storeReveal('ali', '2026-10-06')
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(await reveals()).toHaveLength(1)
  })

  it.each([
    ['a seed', { is_seed: true }, 1],
    ['photo-less', {}, 0],
  ])('does not clear an unanswered reveal who is %s', async (_name, user, photos) => {
    await addLiker('ali', { user, photos })
    await addLiker('reza')
    await storeReveal('ali', '2026-10-06')
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(await reveals()).toHaveLength(1)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('shows nobody for the rest of the day after she passes him', async () => {
    await addLiker('ali')
    await addLiker('reza')
    await pass(woman, { id: ids.ali })
    await storeReveal('ali', '2026-10-07')
    await expect(run()).resolves.toEqual({ applies: true, swiperId: null })
    expect(await reveals()).toHaveLength(1)
  })

  it('picks the next queued person on the next Tehran day', async () => {
    await addLiker('ali')
    await addLiker('reza', { user: { last_active: '2026-10-07T11:00:00.000Z' } })
    await pass(woman, { id: ids.ali })
    await storeReveal('ali', '2026-10-07')
    await expect(run(NEXT_DAY)).resolves.toEqual({ applies: true, swiperId: 'reza' })
    const rows = await reveals()
    expect(rows.map((r) => [nameOf(r.swiper_id), r.revealed_on])).toEqual([['ali', '2026-10-07'], ['reza', '2026-10-08']])
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
  })

  describe.each([
    ['blocked by her', (id: string) => block(woman, { id })],
    ['blocking her', (id: string) => block({ id }, woman)],
    ['banned', (id: string) => sql`update users set banned_at = '2026-10-06T00:00:00Z' where id = ${id}`],
    ['deleted', (id: string) => sql`update users set deleted_at = '2026-10-06T00:00:00Z' where id = ${id}`],
    ['paused', (id: string) => sql`update users set paused_at = '2026-10-06T00:00:00Z' where id = ${id}`],
    ['matched', (id: string) => createMatch(id, woman.id)],
  ] as Array<[string, (id: string) => Promise<unknown>]>)('a dead current reveal (%s)', (_name, kill) => {
    beforeEach(async () => {
      await addLiker('ali')
      await addLiker('reza', { user: { last_active: '2026-10-07T11:00:00.000Z' } })
      await storeReveal('ali', '2026-10-07')
      await kill(ids.ali)
    })

    it('same Tehran day returns swiperId null and does not insert', async () => {
      await expect(run()).resolves.toEqual({ applies: true, swiperId: null })
      expect(await reveals()).toHaveLength(1)
      expect(notifyNewLike).not.toHaveBeenCalled()
    })

    it('next Tehran day inserts the other candidate once', async () => {
      await expect(run(NEXT_DAY)).resolves.toEqual({ applies: true, swiperId: 'reza' })
      expect((await reveals()).map((r) => nameOf(r.swiper_id))).toEqual(['ali', 'reza'])
      expect(notifyNewLike).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['blocks', 'matches', 'swipes'])('throws when a liveness read (%s) errors, without replacing him', async (table) => {
    await addLiker('ali')
    await addLiker('reza')
    await storeReveal('ali', '2026-10-06')
    await expect(withTableGone(table, () => ensureDailyReveal(woman.id, NEXT_DAY))).rejects.toBeTruthy()
    expect(await reveals()).toHaveLength(1)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('never chooses a seed', async () => {
    await addLiker('fake', { user: { is_seed: true } })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: null })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('never chooses a photo-less liker', async () => {
    await addLiker('nophoto', { photos: 0 })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: null })
  })

  it('ranks likers beyond the newest 100', async () => {
    // 120 newer likers are all paused; the only eligible one is the oldest.
    for (let i = 0; i < 120; i++) {
      await addLiker(`new-${String(i).padStart(3, '0')}`, {
        createdAt: '2026-10-05T00:00:00.000Z',
        user: { paused_at: '2026-10-06T00:00:00.000Z' },
        photos: 0,
      })
    }
    await addLiker('old', { createdAt: '2026-01-01T00:00:00.000Z' })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'old' })
  })

  it('does not pick likers she swiped, blocked, matched, or who are banned or deleted', async () => {
    await addLiker('swiped'); await pass(woman, { id: ids.swiped })
    await addLiker('blocked'); await block({ id: ids.blocked }, woman)
    await addLiker('matched'); await createMatch(woman.id, ids.matched)
    await addLiker('banned', { user: { banned_at: '2026-10-01T00:00:00Z' } })
    await addLiker('deleted', { user: { deleted_at: '2026-10-01T00:00:00Z' } })
    await addLiker('ok', { user: { last_active: '2026-10-01T00:00:00.000Z' } })
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ok' })
  })

  it('stores the row and skips the DM when she has refused bot writes', async () => {
    await sql`update users set allows_write_to_pm = false where id = ${woman.id}`
    await addLiker('ali')
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect((await reveals())[0].notified_at).toBeNull()
  })

  it('still returns the reveal when the like DM fails (and leaves notified_at empty)', async () => {
    await addLiker('ali')
    vi.mocked(notifyNewLike).mockRejectedValue(new Error('Telegram down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(run()).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    expect((await reveals())[0].notified_at).toBeNull()
    errSpy.mockRestore()
  })

  it('two concurrent calls store one reveal, agree on him, and DM once', async () => {
    await addLiker('ali')
    await addLiker('reza', { user: { last_active: '2026-10-07T09:30:00.000Z' } })
    const [a, b] = await Promise.all([ensureDailyReveal(woman.id, NOW), ensureDailyReveal(woman.id, NOW)])
    expect(a).toEqual(b)
    expect(nameOf((a as any).swiperId)).toBe('reza')
    expect(await reveals()).toHaveLength(1)
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
  })
})

describe('hiddenIncomingLikerIds', () => {
  it('hides every incoming liker except the revealed one', async () => {
    await addLiker('ali')
    await addLiker('reza')
    await storeReveal('ali', '2026-10-07')
    await expect(hiddenIncomingLikerIds(woman.id, NOW)).resolves.toEqual([ids.reza])
  })

  it('returns [] when the reveal does not apply', async () => {
    await sql`update users set gender = 'man' where id = ${woman.id}`
    await addLiker('ali')
    await expect(hiddenIncomingLikerIds(woman.id, NOW)).resolves.toEqual([])
  })

  it('includes every liker, past 1000 rows', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      telegram_id: 9_000_000 + i, name: `m${i}`, age: 30, gender: 'man', looking_for: 'women', account_status: 'active',
    }))
    const men = await sql<{ id: string }[]>`insert into users ${sql(rows)} returning id`
    await sql`
      insert into swipes ${sql(men.map((m) => ({ swiper_id: m.id, swiped_id: woman.id, direction: 'like' })))}`
    ids.first = men[0].id
    await storeReveal('first', '2026-10-07')
    const hidden = await hiddenIncomingLikerIds(woman.id, NOW)
    expect(hidden).toHaveLength(1199)
    expect(hidden).not.toContain(men[0].id)
    expect(hidden).toContain(men[1].id)
    expect(hidden).toContain(men[1199].id)
  })

  it('does not wait for the like DM before returning', async () => {
    await addLiker('ali', { user: { last_active: '2026-10-07T09:00:00.000Z' } })
    await addLiker('reza', { user: { last_active: '2026-09-01T09:00:00.000Z' } })
    vi.mocked(notifyNewLike).mockReturnValueOnce(new Promise(() => {}))
    await expect(hiddenIncomingLikerIds(woman.id, NOW)).resolves.toEqual([ids.reza])
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
  })

  it('hides everyone (incl. a dead reveal) when nobody is revealed', async () => {
    await addLiker('ali')
    await addLiker('reza')
    await storeReveal('ali', '2026-10-07')
    await block(woman, { id: ids.ali })
    const hidden = await hiddenIncomingLikerIds(woman.id, NOW)
    expect(hidden.sort()).toEqual([ids.ali, ids.reza].sort())
  })
})
