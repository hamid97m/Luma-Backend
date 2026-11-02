import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db.js', async (orig) => {
  const m = await orig<typeof import('../src/db.js')>()
  const { withFaults } = await import('./helpers/sql-faults.js')
  return { ...m, sql: withFaults(m.sql) }
})
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { notifyMatch, notifyNewMessage, notifyNewLike } from '../src/bot.js'
import { runFakeLikerJob } from '../src/jobs/fakeLiker.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { icebreakerQuestion } from '../src/icebreakers/catalog.js'
import { tFor } from '../src/i18n/index.js'
import { resetDb, insertRow, sql } from './helpers/db.js'
import { failQuery, clearFaults, queriesRun, withoutFaults } from './helpers/sql-faults.js'

// ---------------------------------------------------------------------------
// Scenario fixtures: each test describes its world as a `Store` keyed by table
// with readable symbolic ids ('f1', 't1', 'm1'). `useStore` writes it into the
// real Postgres (symbolic ids → uuids whose sort order matches the symbols, so
// "sorted pair" assertions still hold), and `logs.inserts()` reads back the
// rows the job created, translated back to symbolic ids. The `__fail*` hooks
// inject query failures (postgres.js throws; the job must count/log and go on).
// ---------------------------------------------------------------------------

type Store = Record<string, any[]> & {
  __failInsert?: Record<string, boolean> // insert into <table> throws
  __failSelect?: Record<string, boolean> // plain multi-row select on <table> throws
  __failCount?: Record<string, boolean> // count(*) on <table> throws
  __failSingle?: Record<string, boolean> // the single-row reverse-like lookup (`select id from <table>`) throws
  __failCountMatch?: Set<string> // message count(*) for these match ids throws
}

const ID = new Map<string, string>() // symbolic → uuid
const NAME = new Map<string, string>() // uuid → symbolic
/** uuid for a symbolic id (users/matches seeded by the current test, or 'match-N' after `inserts()`). */
const id = (sym: string): string => {
  const v = ID.get(sym)
  if (!v) throw new Error(`unknown symbolic id ${sym}`)
  return v
}
const sym = (uuid: string | null): string | null => (uuid == null ? null : NAME.get(uuid) ?? uuid)

function uuidAt(prefix: number, i: number): string {
  return `${String(prefix).padStart(8, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
}

interface Logs {
  /** Rows the job inserted (not seeded), symbolic ids restored; a table is absent when nothing was inserted. */
  inserts: () => Promise<Record<string, any[]>>
}

async function useStore(store: Store): Promise<Logs> {
  ID.clear()
  NAME.clear()
  const users = store.users ?? []

  // Every symbolic user id referenced anywhere; unknown ones become inert placeholders.
  const userSyms = new Set<string>(users.map((u) => u.id))
  for (const s of store.swipes ?? []) { userSyms.add(s.swiper_id); userSyms.add(s.swiped_id) }
  for (const m of store.matches ?? []) { userSyms.add(m.user1_id); userSyms.add(m.user2_id) }
  ;[...userSyms].sort().forEach((s, i) => { ID.set(s, uuidAt(1, i + 1)); NAME.set(uuidAt(1, i + 1), s) })
  ;(store.matches ?? []).forEach((m, i) => { ID.set(m.id, uuidAt(2, i + 1)); NAME.set(uuidAt(2, i + 1), m.id) })

  // fake_liker_config: [] = row missing; otherwise apply the given values.
  const cfg = store.fake_liker_config
  if (cfg && cfg.length === 0) await sql`delete from fake_liker_config`
  else if (cfg?.[0]) {
    await sql`update fake_liker_config set enabled = ${cfg[0].enabled}, max_targets_per_run = ${cfg[0].max_targets_per_run}`
  }

  // telegram_id is UNIQUE: keep explicit ids, re-number the builder defaults (1000 / -1).
  const usedTg = new Set<number>()
  let nextPos = 2_000_000
  let nextNeg = -2_000_000
  const known = new Set(users.map((u) => u.id))
  for (const u of users) {
    let tg = u.telegram_id as number
    if (tg === 1000 || tg === -1 || usedTg.has(tg)) tg = tg > 0 ? nextPos++ : nextNeg--
    usedTg.add(tg)
    await insertRow('users', { age: 28, ...u, id: id(u.id), telegram_id: tg })
  }
  const placeholders = [...userSyms].filter((s) => !known.has(s)).map((s) => ({
    id: id(s), telegram_id: nextPos++, name: `P-${s}`, age: 30, gender: 'man', looking_for: 'women',
    is_active: false, account_status: 'active',
  }))
  if (placeholders.length) await sql`insert into users ${sql(placeholders)}`

  for (const p of store.user_photos ?? []) await insertRow('user_photos', { ...p, user_id: id(p.user_id) })
  for (const s of store.swipes ?? []) {
    await insertRow('swipes', { ...s, swiper_id: id(s.swiper_id), swiped_id: id(s.swiped_id) })
  }
  for (const m of store.matches ?? []) {
    await insertRow('matches', { ...m, id: id(m.id), user1_id: id(m.user1_id), user2_id: id(m.user2_id) })
  }
  for (const msg of store.messages ?? []) {
    await insertRow('messages', { ...msg, match_id: id(msg.match_id), sender_id: id(msg.sender_id) })
  }

  // Fault hooks → query predicates on the real SQL text.
  for (const t of Object.keys(store.__failInsert ?? {})) failQuery((q) => q.startsWith(`insert into ${t}`))
  for (const t of Object.keys(store.__failCount ?? {})) failQuery((q) => /count\(\*\)/.test(q) && q.includes(` from ${t} `))
  for (const t of Object.keys(store.__failSingle ?? {})) failQuery((q) => q.startsWith(`select id from ${t} `))
  for (const t of Object.keys(store.__failSelect ?? {})) {
    failQuery((q) => q.startsWith('select ') && !/count\(\*\)/.test(q) && !q.startsWith('select id from')
      && q.includes(` from ${t} `))
  }
  if (store.__failCountMatch?.size) {
    const bad = new Set([...store.__failCountMatch].map(id))
    failQuery((q, values) => /count\(\*\)/.test(q) && q.includes(' from messages ') && values.some((v) => bad.has(v as string)))
  }

  const seeded = {
    swipes: new Set((await sql`select id from swipes`).map((r) => r.id)),
    matches: new Set((await sql`select id from matches`).map((r) => r.id)),
    messages: new Set((await sql`select id from messages`).map((r) => r.id)),
  }

  return {
    inserts: () => withoutFaults(async () => {
      const out: Record<string, any[]> = {}
      const swipes = (await sql`select id, swiper_id, swiped_id, direction from swipes order by created_at, id`)
        .filter((r) => !seeded.swipes.has(r.id))
        .map((r) => ({ swiper_id: sym(r.swiper_id), swiped_id: sym(r.swiped_id), direction: r.direction }))
      if (swipes.length) out.swipes = swipes
      const matches = (await sql`select id, user1_id, user2_id from matches order by created_at, id`)
        .filter((r) => !seeded.matches.has(r.id))
      matches.forEach((m, i) => {
        if (!NAME.has(m.id)) { ID.set(`match-${i + 1}`, m.id); NAME.set(m.id, `match-${i + 1}`) }
      })
      if (matches.length) {
        out.matches = matches.map((m) => ({ id: sym(m.id), user1_id: sym(m.user1_id), user2_id: sym(m.user2_id) }))
      }
      const messages = (await sql`select id, match_id, sender_id, body from messages order by created_at, id`)
        .filter((r) => !seeded.messages.has(r.id))
        .map((r) => ({ match_id: sym(r.match_id), sender_id: sym(r.sender_id), body: r.body }))
      if (messages.length) out.messages = messages
      const runs = await sql`select * from fake_liker_runs`
      if (runs.length) out.fake_liker_runs = runs
      return out
    }),
  }
}

/** The greeting fakes open with, in the real user's language (null locale → Persian). */
const SALAM = tFor(null).chat.seedGreeting

// --- data builders --------------------------------------------------------
const OLD = '2020-01-01T00:00:00Z'
const RECENT = new Date().toISOString()
const STALE = new Date(Date.now() - 30 * 60 * 1000).toISOString()

function mkUser(id: string, o: Partial<any> = {}) {
  return {
    id, name: `U-${id}`, is_seed: false, gender: 'man', looking_for: 'women',
    location: null, is_active: true, account_status: 'active', banned_at: null, deleted_at: null,
    telegram_id: 1000, allows_write_to_pm: null, last_active: null,
    notified_offline_at: null, created_at: OLD, ...o,
  }
}
function mkFake(id: string, o: Partial<any> = {}) {
  return mkUser(id, { is_seed: true, gender: 'woman', looking_for: 'both', telegram_id: -1, name: `F-${id}`, ...o })
}
function enabledConfig(max = 100) {
  return [{ id: true, enabled: true, max_targets_per_run: max }]
}

const silent = { info: () => {}, warn: () => {} }
const mkLogger = () => ({ info: vi.fn(), warn: vi.fn() })
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(async () => {
  vi.clearAllMocks()
  await resetDb()
})
afterEach(clearFaults)

// ---------------------------------------------------------------------------

describe('runFakeLikerJob — config gating', () => {
  it('returns { skipped: "disabled" } and writes no run row when disabled', async () => {
    const store: Store = { fake_liker_config: [{ id: true, enabled: false, max_targets_per_run: 100 }] }
    const logs = await useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toEqual({ skipped: 'disabled' })
    expect((await logs.inserts()).fake_liker_runs).toBeUndefined()
  })

  it('returns { skipped: "disabled" } when the config row is missing', async () => {
    const store: Store = { fake_liker_config: [] }
    const logs = await useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toEqual({ skipped: 'disabled' })
    expect((await logs.inserts()).fake_liker_runs).toBeUndefined()
  })
})

describe('runFakeLikerJob — fake pool', () => {
  it('records a zeroed run and finishes when the fake pool is empty', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkUser('t1', { created_at: OLD })], // real user, no fakes
    }
    const logs = await useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toMatchObject({ likesSent: 0, matchesCreated: 0, salamsSent: 0 })
    expect((await logs.inserts()).fake_liker_runs).toHaveLength(1)
    expect((await logs.inserts()).fake_liker_runs[0]).toMatchObject({ likes_sent: 0, matches_created: 0 })
  })
})

describe('runFakeLikerJob — target selection', () => {
  it('excludes seed / too-new / wrong looking_for / already-liked users', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('ok', { created_at: OLD, looking_for: 'both', gender: 'man' }),          // eligible
        mkUser('seed', { is_seed: true, gender: 'woman', looking_for: 'both' }),          // seed → excluded
        mkUser('new', { created_at: RECENT, looking_for: 'both', gender: 'man' }),        // <4h → excluded
        mkUser('wrong', { created_at: OLD, looking_for: 'men', gender: 'man' }),          // wrong looking_for → excluded
        mkUser('liked', { created_at: OLD, looking_for: 'both', gender: 'man' }),         // already has a received like
      ],
      swipes: [{ swiper_id: 'someone', swiped_id: 'liked', direction: 'like' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    // only 'ok' should be liked
    expect(res.likesSent).toBe(1)
    expect((await logs.inserts()).swipes.map((s: any) => s.swiped_id)).toEqual(['ok'])
  })
})

describe('runFakeLikerJob — same language', () => {
  it('Iranian fakes only like Persian users (fa, or unset which is Persian)', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('fa', { created_at: '2020-04-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: 'fa' }),
        mkUser('unset', { created_at: '2020-03-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: null }),
        mkUser('en', { created_at: '2020-02-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: 'en' }),
        mkUser('ar', { created_at: '2020-01-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: 'ar' }),
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(2)
    expect((await logs.inserts()).swipes.map((s: any) => s.swiped_id).sort()).toEqual(['fa', 'unset'])
  })

  it('does not like back a non-Persian user who liked an Iranian fake', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('en', { gender: 'man', looking_for: 'both', locale: 'en', telegram_id: 42 }),
      ],
      swipes: [{ swiper_id: 'en', swiped_id: 'f1', direction: 'like' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(0)
    expect(res.matchesCreated).toBe(0)
    expect((await logs.inserts()).swipes).toBeUndefined()
    expect((await logs.inserts()).messages).toBeUndefined()
  })

  it('does not open a chat with a non-Persian user on an existing match', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('en', { looking_for: 'men', created_at: OLD, locale: 'en', telegram_id: 42 }),
      ],
      matches: [{ id: 'm1', user1_id: 'en', user2_id: 'f1', created_at: OLD }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect((await logs.inserts()).messages).toBeUndefined()
  })

  it('an English fake messages English users and skips Persian ones', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('enBot', { locale: 'en' }),
        mkUser('fa', { created_at: '2020-02-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: 'fa' }),
        mkUser('en', { created_at: '2020-01-01T00:00:00Z', gender: 'man', looking_for: 'both', locale: 'en' }),
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(1)
    expect((await logs.inserts()).swipes).toEqual([{ swiper_id: 'enBot', swiped_id: 'en', direction: 'like' }])
  })
})

describe('runFakeLikerJob — compatibility filter', () => {
  it('a fake only likes targets whose gender her looking_for allows', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { looking_for: 'men' }),                                   // likes only men
        mkUser('man', { gender: 'man', looking_for: 'both', created_at: OLD }),
        mkUser('woman', { gender: 'woman', looking_for: 'both', created_at: OLD }),
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(1)
    expect((await logs.inserts()).swipes.map((s: any) => s.swiped_id)).toEqual(['man'])
  })
})

describe('runFakeLikerJob — load balancing', () => {
  it('picks the lowest-counter fake, breaking ties by same city', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('A', { location: 'NYC' }),
        mkFake('B', { location: 'LA' }),
        mkUser('t1', { location: 'LA', created_at: '2020-02-01T00:00:00Z', gender: 'man', looking_for: 'both' }),
        mkUser('t2', { location: 'NYC', created_at: '2020-01-01T00:00:00Z', gender: 'man', looking_for: 'both' }),
      ],
    }
    const logs = await useStore(store)
    await runFakeLikerJob('schedule', silent)
    const pairs = (await logs.inserts()).swipes.map((s: any) => [s.swiper_id, s.swiped_id])
    // t1 (created later → processed first): tie on counter, B shares LA → B likes t1.
    // t2: A now has the lower counter → A likes t2.
    expect(pairs).toEqual([['B', 't1'], ['A', 't2']])
  })

  it('seeds counters from swipe history so the busier fake is skipped', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('A'),
        mkFake('B'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' }),
      ],
      // A already liked two people historically → B (counter 0) should win.
      swipes: [
        { swiper_id: 'A', swiped_id: 'x', direction: 'like' },
        { swiper_id: 'A', swiped_id: 'y', direction: 'like' },
      ],
    }
    const logs = await useStore(store)
    await runFakeLikerJob('schedule', silent)
    expect((await logs.inserts()).swipes.map((s: any) => [s.swiper_id, s.swiped_id])).toEqual([['B', 't1']])
  })
})

describe('runFakeLikerJob — swipe conflict', () => {
  it('counts a duplicate swipe (23505) as skipped, not a like', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' }),
      ],
      // f1 previously PASSED on t1 — t1 has no *received like* (so it survives target
      // selection), but re-inserting the like collides on UNIQUE(swiper_id, swiped_id).
      swipes: [{ swiper_id: 'f1', swiped_id: 't1', direction: 'pass' }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(0)
    expect(res.skipped).toBe(1)
  })
})

describe('runFakeLikerJob — match creation', () => {
  it('creates a match on reverse-like with a SORTED pair and notifies only the real user', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 555, last_active: RECENT, locale: 'fa' }),
      ],
      // target already liked the fake → reverse like present
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.matchesCreated).toBe(1)
    // sorted: 'f1' < 't1'
    expect((await logs.inserts()).matches[0]).toMatchObject({ user1_id: 'f1', user2_id: 't1' })
    expect(notifyMatch).toHaveBeenCalledTimes(1)
    // The DM carries the REAL user's locale (fakes have none) and deep-links the chat.
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 555, matchName: 'Sara', matchPhoto: 'https://p/f1.jpg', locale: 'fa', matchId: id('match-1'), question: null },
    ])
    // Fake's icebreaker first, then the real user's.
    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith(id('match-1'), [id('f1'), id('t1')])
  })

  it("asks the fake's question in the real user's language when she has an icebreaker", async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara', locale: 'en', icebreaker_prompt: 'جمعه ایده‌آل من…', icebreaker_answer: 'Beach' }),
        mkUser('t1', { gender: 'man', looking_for: 'both', telegram_id: 555, last_active: RECENT, locale: 'en' }),
      ],
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
    }
    const logs = await useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()
    await logs.inserts()

    expect(notifyMatch).toHaveBeenCalledWith([
      expect.objectContaining({ matchId: id('match-1'), question: icebreakerQuestion('جمعه ایده‌آل من…', 'en') }),
    ])
  })

  it('tolerates a match 23505 (already matched) — no match count, no notify', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 555, last_active: RECENT }),
      ],
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
      matches: [{ id: 'm-existing', user1_id: 'f1', user2_id: 't1' }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.matchesCreated).toBe(0)
    expect(res.likesSent).toBe(1)
    expect(notifyMatch).not.toHaveBeenCalled()
    expect(seedIcebreakers).not.toHaveBeenCalled()
  })

  it('does not notify a match when the real user opted out or has a sentinel id', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 555, allows_write_to_pm: false, last_active: RECENT }),
      ],
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.matchesCreated).toBe(1)
    expect(notifyMatch).not.toHaveBeenCalled()
  })
})

describe('runFakeLikerJob — like-back phase', () => {
  it('likes back the EXACT fake a real user liked, creating a match (multi-fake, deterministic)', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Ava' }),
        mkFake('f2', { name: 'Bea' }),
        mkUser('r1', { gender: 'man', looking_for: 'both', telegram_id: 777, last_active: RECENT, locale: 'fa' }),
      ],
      // r1 liked f2 specifically (not f1)
      swipes: [{ swiper_id: 'r1', swiped_id: 'f2', direction: 'like' }],
      user_photos: [{ user_id: 'f2', url: 'https://p/f2.jpg', position: 0 }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.matchesCreated).toBe(1)
    // f2 (the liked fake) likes r1 back — never f1
    expect((await logs.inserts()).swipes).toEqual([{ swiper_id: 'f2', swiped_id: 'r1', direction: 'like' }])
    expect((await logs.inserts()).matches[0]).toMatchObject({ user1_id: 'f2', user2_id: 'r1' }) // 'f2' < 'r1'
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 777, matchName: 'Bea', matchPhoto: 'https://p/f2.jpg', locale: 'fa', matchId: id('match-1'), question: null },
    ])
    expect(seedIcebreakers).toHaveBeenCalledWith(id('match-1'), [id('f2'), id('r1')])
  })

  it('likes back even a user who already has a received like (bypasses the cold-pass exclusion)', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Ava' }),
        mkUser('r1', { gender: 'man', looking_for: 'both', telegram_id: 777 }),
      ],
      swipes: [
        { swiper_id: 'r1', swiped_id: 'f1', direction: 'like' }, // r1 liked the fake
        { swiper_id: 'other', swiped_id: 'r1', direction: 'like' }, // r1 already has a received like
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.matchesCreated).toBe(1)
    expect((await logs.inserts()).matches[0]).toMatchObject({ user1_id: 'f1', user2_id: 'r1' })
  })

  it('skips a pair already matched — no duplicate like-back', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('r1', { gender: 'man', looking_for: 'both' }),
      ],
      swipes: [
        { swiper_id: 'r1', swiped_id: 'f1', direction: 'like' },
        { swiper_id: 'other', swiped_id: 'r1', direction: 'like' }, // excludes r1 from cold pass too
      ],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.matchesCreated).toBe(0)
    expect((await logs.inserts()).swipes).toBeUndefined() // no new like inserted at all
  })

  it('spends the shared per-run budget on warm like-backs before cold outreach', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(1), // budget of 1
      users: [
        mkFake('f1', { name: 'Ava' }),
        mkUser('warm', { gender: 'man', looking_for: 'both', telegram_id: 777 }), // liked the fake
        mkUser('cold', { gender: 'man', looking_for: 'both', created_at: OLD }), // cold-eligible, zero likes
      ],
      swipes: [{ swiper_id: 'warm', swiped_id: 'f1', direction: 'like' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.likesSent).toBe(1)
    // budget is exhausted by the warm lead → 'cold' is never liked this run
    expect((await logs.inserts()).swipes.map((s: any) => s.swiped_id)).toEqual(['warm'])
    expect(res.matchesCreated).toBe(1)
  })

  it('does not like back a liker whose gender the fake is not looking for', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { looking_for: 'men' }), // wants men only
        mkUser('w1', { gender: 'woman', looking_for: 'both', created_at: OLD }), // a woman liked her
      ],
      swipes: [{ swiper_id: 'w1', swiped_id: 'f1', direction: 'like' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.likesSent).toBe(0)
    expect(res.matchesCreated).toBe(0)
    expect((await logs.inserts()).swipes).toBeUndefined()
  })

  it('caps fake matches per user — a 3rd liked fake is not reciprocated once at 2 matches', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'), mkFake('f2'), mkFake('f3'),
        mkUser('r1', { gender: 'man', looking_for: 'both', created_at: OLD }),
      ],
      swipes: [
        { swiper_id: 'f1', swiped_id: 'r1', direction: 'like' }, // received likes → not zero-liked (cold excludes r1)
        { swiper_id: 'f2', swiped_id: 'r1', direction: 'like' },
        { swiper_id: 'r1', swiped_id: 'f3', direction: 'like' }, // r1 now likes a 3rd fake
      ],
      matches: [
        { id: 'm1', user1_id: 'f1', user2_id: 'r1' }, // already 2 fake matches
        { id: 'm2', user1_id: 'f2', user2_id: 'r1' },
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.matchesCreated).toBe(0) // r1 is at the cap → f3 does not like back
    expect((await logs.inserts()).swipes).toBeUndefined()
  })

  it('trickles — a user who liked 3 fakes gets only ONE new match this run', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'), mkFake('f2'), mkFake('f3'),
        mkUser('r1', { gender: 'man', looking_for: 'both', created_at: OLD, telegram_id: 777 }),
      ],
      swipes: [
        { swiper_id: 'r1', swiped_id: 'f1', direction: 'like' },
        { swiper_id: 'r1', swiped_id: 'f2', direction: 'like' },
        { swiper_id: 'r1', swiped_id: 'f3', direction: 'like' },
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.likesSent).toBe(1) // one fake likes back this run, not all three
    expect(res.matchesCreated).toBe(1)
    expect((await logs.inserts()).swipes).toHaveLength(1)
  })
})

describe('runFakeLikerJob — new-like notification', () => {
  it('DMs a real target when the fake likes them with no reverse like', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 777, locale: 'fa' }),
      ],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.likesSent).toBe(1)
    expect(res.matchesCreated).toBe(0)
    expect(notifyNewLike).toHaveBeenCalledWith(777, 'Sara', 'fa')
  })

  it('passes a null locale for a target who has not picked a language yet', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 777, locale: null }),
      ],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    await useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()
    expect(notifyNewLike).toHaveBeenCalledWith(777, 'Sara', null)
  })

  it('does not notify when the target has a fake/sentinel telegram id', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: -5 }),
      ],
    }
    await useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()

    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('does not DM a woman target', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'woman', looking_for: 'both', telegram_id: 777, locale: 'fa' }),
      ],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.likesSent).toBe(1)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('does not send a new-like DM when the like results in a match', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 555, last_active: RECENT }),
      ],
      // target already liked the fake → reverse like present → matches instead
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.matchesCreated).toBe(1)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })
})

describe('runFakeLikerJob — salam phase', () => {
  // Real users use looking_for:'men' so they are NOT selected as like targets;
  // this isolates the salam phase from the like phase.
  const realOpts = { looking_for: 'men', created_at: OLD }

  it('sends salam only for zero-message matches and skips both-fake matches', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkFake('f2'),
        mkUser('r1', { ...realOpts, last_active: RECENT }),
        mkUser('r2', { ...realOpts, last_active: RECENT }),
      ],
      matches: [
        { id: 'm1', user1_id: 'f1', user2_id: 'r1' }, // zero messages → salam
        { id: 'm2', user1_id: 'f1', user2_id: 'f2' }, // both fake → skip
        { id: 'm3', user1_id: 'f1', user2_id: 'r2' }, // has a message → skip
      ],
      messages: [{ match_id: 'm3', sender_id: 'r2', body: 'hey' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect((await logs.inserts()).messages).toEqual([{ match_id: 'm1', sender_id: 'f1', body: SALAM }])
  })

  it('still salams a match whose only messages are auto-posted icebreakers', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('r1', { ...realOpts, last_active: RECENT })],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1' }],
      messages: [
        { match_id: 'm1', sender_id: 'f1', type: 'icebreaker', body: 'My ideal Friday…', icebreaker_answer: 'x' },
        { match_id: 'm1', sender_id: 'r1', type: 'icebreaker', body: 'Two truths and a lie…', icebreaker_answer: 'y' },
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect((await logs.inserts()).messages).toEqual([expect.objectContaining({ match_id: 'm1', sender_id: 'f1' })])
  })

  it('skips matches whose real side is deleted or banned', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('rdel', { ...realOpts, deleted_at: '2026-01-01T00:00:00Z' }),
        mkUser('rban', { ...realOpts, banned_at: '2026-01-01T00:00:00Z' }),
      ],
      matches: [
        { id: 'm1', user1_id: 'f1', user2_id: 'rdel' },
        { id: 'm2', user1_id: 'f1', user2_id: 'rban' },
      ],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect((await logs.inserts()).messages).toBeUndefined()
  })

  it('does not salam a both-fake match even if it has zero messages', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkFake('f2')],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'f2' }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect((await logs.inserts()).messages).toBeUndefined()
  })

  it('orders the salam match queries by created_at descending', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('r1', { looking_for: 'men', created_at: OLD, last_active: RECENT })],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1', created_at: OLD }],
    }
    await useStore(store)
    await runFakeLikerJob('schedule', silent)
    // both the user1_id and the user2_id match queries take the newest-first window
    const salamQueries = queriesRun().filter((q) => q.text.startsWith('select id, user1_id, user2_id, created_at from matches'))
    expect(salamQueries).toHaveLength(2)
    expect(salamQueries.every((q) => / order by created_at desc/.test(q.text))).toBe(true)
  })

  it('salams the newest zero-message match when merged candidates exceed the cap', async () => {
    // Build > SALAM_CAP (200) fake-involved matches. The oldest ones already have
    // messages; only the single NEWEST match is zero-message. Without recency
    // ordering + a recency-based cap, that newest match would be starved out of
    // the 200-row window and never salam'd.
    const CAP = 200
    const users: any[] = [mkFake('f1', { name: 'Sara' })]
    const matches: any[] = []
    const messages: any[] = []
    for (let i = 0; i < CAP + 50; i++) {
      const rid = `r${i}`
      // ascending created_at with i; the last index is the newest.
      const created = new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString()
      users.push(mkUser(rid, { looking_for: 'men', created_at: OLD, last_active: RECENT }))
      matches.push({ id: `m${i}`, user1_id: 'f1', user2_id: rid, created_at: created })
      // every match EXCEPT the newest already has a message
      if (i !== CAP + 49) messages.push({ match_id: `m${i}`, sender_id: rid, body: 'hey' })
    }
    const store: Store = { fake_liker_config: enabledConfig(), users, matches, messages }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect((await logs.inserts()).messages).toEqual([{ match_id: `m${CAP + 49}`, sender_id: 'f1', body: SALAM }])
  })
})

describe('runFakeLikerJob — salam notification gating', () => {
  const realOpts = { looking_for: 'men', created_at: OLD }

  async function runWithReal(realOverrides: Partial<any>) {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('r1', { ...realOpts, ...realOverrides }),
      ],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1' }],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    const logs = await useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()
    return logs
  }

  it('notifies an offline, eligible real user and stamps notified_offline_at', async () => {
    await runWithReal({ last_active: STALE, notified_offline_at: null, telegram_id: 777, allows_write_to_pm: null })
    expect(notifyNewMessage).toHaveBeenCalledWith(777, 'Sara', SALAM, 'https://p/f1.jpg', id('m1'), null)
    await vi.waitFor(async () => {
      const [r1] = await sql`select notified_offline_at from users where id = ${id('r1')}`
      expect(r1.notified_offline_at).not.toBeNull()
    })
    const [f1] = await sql`select notified_offline_at from users where id = ${id('f1')}`
    expect(f1.notified_offline_at).toBeNull()
  })

  it('does not notify when the real user is online (<10 min)', async () => {
    await runWithReal({ last_active: RECENT, telegram_id: 777 })
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('does not notify when allows_write_to_pm is false', async () => {
    await runWithReal({ last_active: STALE, allows_write_to_pm: false, telegram_id: 777 })
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('does not notify when telegram_id is a negative sentinel', async () => {
    await runWithReal({ last_active: STALE, telegram_id: -42 })
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('does not notify when the user was already notified this offline stretch', async () => {
    await runWithReal({ last_active: STALE, notified_offline_at: STALE, telegram_id: 777 })
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })
})

describe('runFakeLikerJob — run row', () => {
  it('records a run row with the correct trigger and stats', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', last_active: RECENT }),
      ],
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }], // → reverse like → match + salam
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('manual', silent)) as any
    const row = (await logs.inserts()).fake_liker_runs[0]
    expect(row).toMatchObject({
      trigger: 'manual',
      likes_sent: res.likesSent,
      matches_created: res.matchesCreated,
      salams_sent: res.salamsSent,
      errors: res.errors,
    })
    expect(row.started_at).toBeTruthy()
    expect(row.finished_at).toBeTruthy()
    expect(res).toMatchObject({ likesSent: 1, matchesCreated: 1, salamsSent: 1 })
  })
})

describe('runFakeLikerJob — error handling (DB errors are counted/logged, never thrown)', () => {
  const realOpts = { looking_for: 'men', created_at: OLD }

  it('seeds counters via per-fake count(*) queries, not a raw-row fetch', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('A'), mkFake('B'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      swipes: [
        { swiper_id: 'A', swiped_id: 'x', direction: 'like' },
        { swiper_id: 'A', swiped_id: 'y', direction: 'like' },
      ],
    }
    const logs = await useStore(store)
    await runFakeLikerJob('schedule', silent)
    // A had 2 historical likes → B (0) wins the like; and the seeding used counts.
    const counts = queriesRun().filter((q) => /^select count\(\*\)::int as count from swipes where swiper_id/.test(q.text))
    expect(counts.length).toBeGreaterThanOrEqual(2)
    expect((await logs.inserts()).swipes.map((s: any) => [s.swiper_id, s.swiped_id])).toEqual([['B', 't1']])
  })

  it('zeroes a fake counter and warns when the counter head-count errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('A'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      __failCount: { swipes: true },
    }
    const logs = await useStore(store)
    const logger = mkLogger()
    const res = (await runFakeLikerJob('schedule', logger)) as any
    // Counter zeroed on error → the fake still likes; a warn is logged.
    expect(res.likesSent).toBe(1)
    expect((await logs.inserts()).swipes.map((s: any) => s.swiped_id)).toEqual(['t1'])
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ fake: id('A') }), expect.stringContaining('counter seed'))
  })

  it('skips a whole candidate batch (no likes) when the received-like fetch errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('ok', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      __failSelect: { swipes: true },
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect((await logs.inserts()).swipes).toBeUndefined()
  })

  it('pages the received-like lookup beyond one page (page-size boundary)', async () => {
    // One eligible candidate 'c1' with exactly PAGE_SIZE (1000) received likes → the
    // first page fills to the cap, so a second page must be requested, and c1 is
    // (correctly) still excluded as already-liked.
    const users: any[] = [mkFake('f1'), mkUser('c1', { created_at: OLD, gender: 'man', looking_for: 'both' })]
    const swipes: any[] = []
    for (let i = 0; i < 1000; i++) swipes.push({ swiper_id: `s${i}`, swiped_id: 'c1', direction: 'like' })
    const store: Store = { fake_liker_config: enabledConfig(), users, swipes }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    const pages = queriesRun()
      .filter((q) => q.text.startsWith('select swiped_id from swipes'))
      .map((q) => q.values.slice(-2))
    // Page 1 was full (1000) so page 2 (offset 1000) was requested.
    expect(pages).toContainEqual([1000, 0])
    expect(pages).toContainEqual([1000, 1000])
    expect(res.likesSent).toBe(0)
    expect((await logs.inserts()).swipes).toBeUndefined()
  }, 30_000)

  it('sends no salam (and counts errors) when every message-count query errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('r1', { ...realOpts, last_active: RECENT })],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1' }],
      __failCount: { messages: true },
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect((await logs.inserts()).messages).toBeUndefined()
  })

  it('a per-match message-count error skips only that match', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('r1', { ...realOpts, last_active: RECENT }),
        mkUser('r2', { ...realOpts, last_active: RECENT }),
      ],
      matches: [
        { id: 'm1', user1_id: 'f1', user2_id: 'r1' },
        { id: 'm2', user1_id: 'f1', user2_id: 'r2' },
      ],
      __failCountMatch: new Set(['m2']),
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect((await logs.inserts()).messages).toEqual([{ match_id: 'm1', sender_id: 'f1', body: SALAM }])
  })

  it('warns when the run-row insert errors (logged, not thrown)', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1')],
      __failInsert: { fake_liker_runs: true },
    }
    await useStore(store)
    const logger = mkLogger()
    await runFakeLikerJob('schedule', logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything() }), expect.stringContaining('run row insert failed'))
  })

  it('a reverse-like check error creates no match and counts an error', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', last_active: RECENT }),
      ],
      __failSingle: { swipes: true },
    }
    const logs = await useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(1)
    expect(res.matchesCreated).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect((await logs.inserts()).matches).toBeUndefined()
  })
})

describe('runFakeLikerJob — concurrency guard', () => {
  it('a second concurrent run returns { skipped: "already_running" }', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
    }
    await useStore(store)
    const p1 = runFakeLikerJob('schedule', silent)
    const p2 = runFakeLikerJob('manual', silent)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r2).toEqual({ skipped: 'already_running' })
    expect(r1).toMatchObject({ likesSent: expect.any(Number) })
  })

  it('a disabled run releases the guard so the next enabled run proceeds', async () => {
    await useStore({ fake_liker_config: [{ id: true, enabled: false, max_targets_per_run: 100 }], users: [mkFake('f1')] })
    expect(await runFakeLikerJob('schedule', silent)).toEqual({ skipped: 'disabled' })
    await sql`update fake_liker_config set enabled = true`
    expect(await runFakeLikerJob('manual', silent)).toMatchObject({ likesSent: 0, errors: 0 })
  })
})
