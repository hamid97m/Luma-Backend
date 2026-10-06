import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyNewLike: vi.fn().mockResolvedValue(undefined) }))

import { db } from '../src/db.js'
import { notifyNewLike } from '../src/bot.js'
import { ensureDailyReveal, hiddenIncomingLikerIds } from '../src/likes/reveal.js'

const NOW = new Date('2026-10-07T10:00:00.000Z') // Tehran date 2026-10-07
const NEXT_DAY = new Date('2026-10-07T21:00:00.000Z') // Tehran 2026-10-08 00:30
const WOMAN = 'woman-1'

type Q = {
  table: string
  op: 'select' | 'insert' | 'update'
  eq: Record<string, unknown>
  inCol?: string
  inVals?: string[]
  or?: string
  range?: [number, number]
  payload?: any
}

type StoredReveal = { swiper_id: string; revealed_on: string; notified_at: string | null }

interface World {
  users: Record<string, any>
  likes: Array<{ swiper_id: string; created_at: string }>
  herSwipes: string[]
  blocks: Array<{ blocker_id: string; blocked_id: string }>
  matches: Array<{ user1_id: string; user2_id: string }>
  photos: Record<string, number>
  reveals: StoredReveal[]
  inserts: any[]
  updates: any[]
  /** table → error returned for every query on it */
  errors: Record<string, unknown>
  calls: string[]
}

let world: World

function userRow(id: string, opts: Record<string, unknown> = {}) {
  return {
    id,
    gender: 'man',
    geo_city: 'Tehran',
    last_active: '2026-10-07T08:00:00.000Z',
    is_seed: false,
    paused_at: null,
    deleted_at: null,
    banned_at: null,
    name: id,
    telegram_id: 50,
    allows_write_to_pm: true,
    locale: 'fa',
    ...opts,
  }
}

function womanRow(opts: Record<string, unknown> = {}) {
  return userRow(WOMAN, { gender: 'woman', telegram_id: 9, ...opts })
}

function newWorld(): World {
  return {
    users: { [WOMAN]: womanRow() },
    likes: [],
    herSwipes: [],
    blocks: [],
    matches: [],
    photos: {},
    reveals: [],
    inserts: [],
    updates: [],
    errors: {},
    calls: [],
  }
}

function addLiker(id: string, opts: { createdAt?: string; photos?: number; user?: Record<string, unknown> } = {}) {
  world.users[id] = userRow(id, opts.user)
  world.photos[id] = opts.photos ?? 1
  world.likes.push({ swiper_id: id, created_at: opts.createdAt ?? '2026-10-01T00:00:00.000Z' })
}

function pairOf(or: string): [string, string] | null {
  const m = or.match(/^and\((\w+)\.eq\.([^,)]+),(\w+)\.eq\.([^,)]+)\)/)
  return m ? [m[2], m[4]] : null
}

function resolve(q: Q): { data: unknown; error: unknown } {
  world.calls.push(`${q.table}:${q.op}`)
  const error = world.errors[q.table] ?? world.errors[`${q.table}:${String(q.eq.id)}`] ?? null
  if (error) return { data: null, error }
  switch (q.table) {
    case 'users': {
      if (q.inCol) return { data: (q.inVals ?? []).map((id) => world.users[id]).filter(Boolean), error: null }
      return { data: world.users[q.eq.id as string] ?? null, error: null }
    }
    case 'like_reveals': {
      if (q.op === 'insert') {
        if (world.reveals.some((r) => r.revealed_on === q.payload.revealed_on)) {
          return { data: null, error: { code: '23505' } }
        }
        world.inserts.push(q.payload)
        world.reveals.push({ swiper_id: q.payload.swiper_id, revealed_on: q.payload.revealed_on, notified_at: null })
        return { data: [{ swiper_id: q.payload.swiper_id }], error: null }
      }
      if (q.op === 'update') {
        world.updates.push(q.payload)
        return { data: null, error: null }
      }
      const sorted = [...world.reveals].sort((a, b) => b.revealed_on.localeCompare(a.revealed_on))
      return { data: sorted.slice(0, 1), error: null }
    }
    case 'swipes': {
      if (q.eq.swiped_id === WOMAN && q.eq.direction === 'like') {
        const sorted = [...world.likes].sort((a, b) => a.swiper_id.localeCompare(b.swiper_id))
        const [from, to] = q.range ?? [0, sorted.length - 1]
        return { data: sorted.slice(from, to + 1), error: null }
      }
      if (q.eq.swiper_id === WOMAN && q.eq.swiped_id) {
        return { data: world.herSwipes.includes(q.eq.swiped_id as string) ? [{ swiped_id: q.eq.swiped_id }] : [], error: null }
      }
      if (q.eq.swiper_id === WOMAN) {
        return { data: world.herSwipes.map((swiped_id) => ({ swiped_id })), error: null }
      }
      return { data: [], error: null }
    }
    case 'blocks': {
      const pair = q.or ? pairOf(q.or) : null
      if (pair) {
        const hit = world.blocks.filter((b) => pair.includes(b.blocker_id) && pair.includes(b.blocked_id))
        return { data: hit.slice(0, 1), error: null }
      }
      return { data: world.blocks, error: null }
    }
    case 'matches': {
      const pair = q.or ? pairOf(q.or) : null
      if (pair) {
        const hit = world.matches.filter((m) => pair.includes(m.user1_id) && pair.includes(m.user2_id))
        return { data: hit.slice(0, 1), error: null }
      }
      return { data: world.matches, error: null }
    }
    case 'user_photos': {
      const rows: Array<{ user_id: string }> = []
      for (const id of q.inVals ?? []) for (let i = 0; i < (world.photos[id] ?? 0); i++) rows.push({ user_id: id })
      return { data: rows, error: null }
    }
  }
  return { data: [], error: null }
}

function fakeQuery(table: string): any {
  const q: Q = { table, op: 'select', eq: {} }
  const proxy: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: any, rej: any) => Promise.resolve(resolve(q)).then(res, rej)
      }
      return (...args: any[]) => {
        switch (prop) {
          case 'insert': q.op = 'insert'; q.payload = args[0]; break
          case 'update': q.op = 'update'; q.payload = args[0]; break
          case 'eq': q.eq[args[0]] = args[1]; break
          case 'in': q.inCol = args[0]; q.inVals = args[1]; break
          case 'or': q.or = args[0]; break
          case 'range': q.range = [args[0], args[1]]; break
        }
        return proxy
      }
    },
  })
  return proxy
}

beforeEach(() => {
  vi.clearAllMocks()
  world = newWorld()
  vi.mocked(db.from).mockImplementation(((table: string) => fakeQuery(table)) as any)
})

const reveal = (swiper_id: string, revealed_on: string, notified_at: string | null = 'x'): StoredReveal => ({
  swiper_id,
  revealed_on,
  notified_at,
})

describe('ensureDailyReveal', () => {
  it('does not apply to a man', async () => {
    world.users[WOMAN] = userRow(WOMAN, { gender: 'man' })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: false })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('does not apply to a missing viewer row', async () => {
    delete world.users[WOMAN]
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: false })
  })

  it('does not apply to a seed viewer and never touches like_reveals', async () => {
    world.users[WOMAN] = womanRow({ is_seed: true })
    addLiker('ali')
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: false })
    expect(world.calls.filter((c) => c.startsWith('like_reveals'))).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('throws when the viewer read errors instead of applying nothing', async () => {
    world.errors.users = { message: 'boom' }
    await expect(ensureDailyReveal(WOMAN, NOW)).rejects.toEqual({ message: 'boom' })
    expect(world.calls.filter((c) => c.startsWith('like_reveals'))).toEqual([])
  })

  it('throws when the latest reveal read errors and does not insert or DM', async () => {
    addLiker('ali')
    world.errors.like_reveals = { message: 'boom' }
    await expect(ensureDailyReveal(WOMAN, NOW)).rejects.toEqual({ message: 'boom' })
    expect(world.inserts).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('picks the eligible liker, stores the row, and DMs once', async () => {
    addLiker('ali', { user: { last_active: '2026-10-07T09:00:00.000Z' } })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(world.inserts).toEqual([{ user_id: WOMAN, swiper_id: 'ali', revealed_on: '2026-10-07' }])
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(notifyNewLike).toHaveBeenCalledWith(9, 'ali', 'fa')
  })

  it('returns the same person without a second DM', async () => {
    addLiker('ali')
    world.reveals = [reveal('ali', '2026-10-07', '2026-10-07T09:00:00.000Z')]
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(world.inserts).toEqual([])
  })

  it('keeps an unanswered reveal from yesterday while he is still live', async () => {
    addLiker('ali')
    addLiker('reza')
    world.reveals = [reveal('ali', '2026-10-06', '2026-10-06T14:30:00.000Z')]
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
    expect(world.inserts).toEqual([])
  })

  it.each([
    ['paused', { paused_at: '2026-10-05T00:00:00.000Z' }, 1],
    ['a seed', { is_seed: true }, 1],
    ['photo-less', {}, 0],
  ])('does not clear an unanswered reveal who is %s', async (_name, user, photos) => {
    addLiker('ali', { user, photos })
    addLiker('reza')
    world.reveals = [reveal('ali', '2026-10-06')]
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(world.inserts).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('shows nobody for the rest of the day after she passes him', async () => {
    addLiker('ali')
    addLiker('reza')
    world.herSwipes = ['ali']
    world.reveals = [reveal('ali', '2026-10-07')]
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: null })
    expect(world.inserts).toEqual([])
  })

  it('picks the next queued person on the next Tehran day', async () => {
    addLiker('ali')
    addLiker('reza', { user: { last_active: '2026-10-07T11:00:00.000Z' } })
    world.herSwipes = ['ali']
    world.reveals = [reveal('ali', '2026-10-07')]
    await expect(ensureDailyReveal(WOMAN, NEXT_DAY)).resolves.toEqual({ applies: true, swiperId: 'reza' })
    expect(world.inserts).toEqual([{ user_id: WOMAN, swiper_id: 'reza', revealed_on: '2026-10-08' }])
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
  })

  describe.each([
    ['blocked by her', (id: string) => world.blocks.push({ blocker_id: WOMAN, blocked_id: id })],
    ['blocking her', (id: string) => world.blocks.push({ blocker_id: id, blocked_id: WOMAN })],
    ['banned', (id: string) => { world.users[id].banned_at = '2026-10-06T00:00:00.000Z' }],
    ['deleted', (id: string) => { world.users[id].deleted_at = '2026-10-06T00:00:00.000Z' }],
    ['matched', (id: string) => world.matches.push({ user1_id: id, user2_id: WOMAN })],
  ] as Array<[string, (id: string) => void]>)('a dead current reveal (%s)', (_name, kill) => {
    beforeEach(() => {
      addLiker('ali')
      addLiker('reza', { user: { last_active: '2026-10-07T11:00:00.000Z' } })
      world.reveals = [reveal('ali', '2026-10-07')]
      kill('ali')
    })

    it('same Tehran day returns swiperId null and does not insert', async () => {
      await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: null })
      expect(world.inserts).toEqual([])
      expect(notifyNewLike).not.toHaveBeenCalled()
    })

    it('next Tehran day inserts the other candidate once', async () => {
      await expect(ensureDailyReveal(WOMAN, NEXT_DAY)).resolves.toEqual({ applies: true, swiperId: 'reza' })
      expect(world.inserts).toEqual([{ user_id: WOMAN, swiper_id: 'reza', revealed_on: '2026-10-08' }])
      expect(notifyNewLike).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['users:ali', 'blocks', 'matches'])('throws when the liveness read (%s) errors, without replacing him', async (key) => {
    addLiker('ali')
    addLiker('reza')
    world.reveals = [reveal('ali', '2026-10-06')]
    world.errors[key] = { message: 'boom' }
    await expect(ensureDailyReveal(WOMAN, NEXT_DAY)).rejects.toEqual({ message: 'boom' })
    expect(world.inserts).toEqual([])
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('never chooses a seed', async () => {
    addLiker('fake', { user: { is_seed: true } })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: null })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('ranks likers beyond the newest 100', async () => {
    // 120 newer likers are all paused; the only eligible one is the oldest.
    for (let i = 0; i < 120; i++) {
      addLiker(`new-${String(i).padStart(3, '0')}`, {
        createdAt: '2026-10-05T00:00:00.000Z',
        user: { paused_at: '2026-10-06T00:00:00.000Z' },
      })
    }
    addLiker('old', { createdAt: '2026-01-01T00:00:00.000Z' })
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'old' })
  })

  it('does not pick likers she swiped, blocked, matched, or who are banned or deleted', async () => {
    addLiker('swiped'); world.herSwipes.push('swiped')
    addLiker('blocked'); world.blocks.push({ blocker_id: 'blocked', blocked_id: WOMAN })
    addLiker('matched'); world.matches.push({ user1_id: WOMAN, user2_id: 'matched' })
    addLiker('banned', { user: { banned_at: 'x' } })
    addLiker('deleted', { user: { deleted_at: 'x' } })
    addLiker('ok')
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ok' })
  })

  it('stores the row and skips the DM when she has refused bot writes', async () => {
    world.users[WOMAN] = womanRow({ allows_write_to_pm: false })
    addLiker('ali')
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('still returns the reveal when the like DM fails', async () => {
    addLiker('ali')
    vi.mocked(notifyNewLike).mockRejectedValue(new Error('Telegram down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(ensureDailyReveal(WOMAN, NOW)).resolves.toEqual({ applies: true, swiperId: 'ali' })
    expect(notifyNewLike).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('hiddenIncomingLikerIds', () => {
  it('hides every incoming liker except the revealed one', async () => {
    addLiker('ali')
    addLiker('reza')
    world.reveals = [reveal('ali', '2026-10-07')]
    await expect(hiddenIncomingLikerIds(WOMAN, NOW)).resolves.toEqual(['reza'])
  })

  it('returns [] when the reveal does not apply', async () => {
    world.users[WOMAN] = userRow(WOMAN, { gender: 'man' })
    addLiker('ali')
    await expect(hiddenIncomingLikerIds(WOMAN, NOW)).resolves.toEqual([])
  })

  it('includes likers outside the newest 100 and pages past 1000 rows', async () => {
    for (let i = 0; i < 1200; i++) {
      const id = `m${String(i).padStart(4, '0')}`
      world.users[id] = userRow(id)
      world.likes.push({ swiper_id: id, created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` })
    }
    world.reveals = [reveal('m0000', '2026-10-07')]
    const hidden = await hiddenIncomingLikerIds(WOMAN, NOW)
    expect(hidden).toHaveLength(1199)
    expect(hidden).not.toContain('m0000')
    expect(hidden).toContain('m0001')
    expect(hidden).toContain('m1199')
  })

  it('hides everyone (incl. a dead reveal) when nobody is revealed', async () => {
    addLiker('ali')
    addLiker('reza')
    world.reveals = [reveal('ali', '2026-10-07')]
    world.blocks.push({ blocker_id: WOMAN, blocked_id: 'ali' })
    const hidden = await hiddenIncomingLikerIds(WOMAN, NOW)
    expect(hidden.sort()).toEqual(['ali', 'reza'])
  })
})
