import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
}))

import { db } from '../src/db.js'
import { notifyMatch, notifyNewMessage, notifyNewLike } from '../src/bot.js'
import { runFakeLikerJob } from '../src/jobs/fakeLiker.js'

// ---------------------------------------------------------------------------
// In-memory Supabase mock: a thenable query builder resolving against seeded
// arrays. Supports exactly the chain methods the job uses. Insert simulates the
// swipes/matches UNIQUE(...) constraints (23505) from the real DB.
// ---------------------------------------------------------------------------

type Store = Record<string, any[]> & {
  __failInsert?: Record<string, boolean>
  // Fault-injection hooks, all keyed by table (supabase-js never throws — it resolves
  // an `{ error }`, so these simulate that path per query shape):
  __failSelect?: Record<string, boolean> // plain multi-row select resolves an error
  __failCount?: Record<string, boolean> // head/count select resolves an error
  __failSingle?: Record<string, boolean> // single()/maybeSingle() select resolves an error
  __failCountMatch?: Set<string> // head/count select whose eq('match_id', x) has x ∈ set errors
}
interface Logs {
  inserts: Record<string, any[]>
  updates: Array<{ table: string; patch: any; filters: any[] }>
}

class QB {
  private op: 'select' | 'insert' | 'update' = 'select'
  private filters: Array<[string, string, any]> = []
  private _order: { col: string; ascending: boolean } | null = null
  private _range: [number, number] | null = null
  private _limit: number | null = null
  private _insert: any = null
  private _update: any = null
  private _selected = false
  private _single: 'single' | 'maybe' | null = null
  private _count = false
  private _head = false

  constructor(private table: string, private store: Store, private logs: Logs) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'insert') this._selected = true
    if (opts?.count) {
      this._count = true
      this._head = !!opts.head
    }
    return this
  }
  insert(row: any) { this.op = 'insert'; this._insert = row; return this }
  update(patch: any) { this.op = 'update'; this._update = patch; return this }
  eq(col: string, val: any) { this.filters.push(['eq', col, val]); return this }
  is(col: string, val: any) { this.filters.push(['is', col, val]); return this }
  in(col: string, val: any[]) { this.filters.push(['in', col, val]); return this }
  lte(col: string, val: any) { this.filters.push(['lte', col, val]); return this }
  order(col: string, opts?: { ascending?: boolean }) {
    this._order = { col, ascending: opts?.ascending !== false }
    return this
  }
  range(from: number, to: number) { this._range = [from, to]; return this }
  limit(n: number) { this._limit = n; return this }
  single() { this._single = 'single'; return this }
  maybeSingle() { this._single = 'maybe'; return this }

  then(resolve: any, reject: any) {
    return Promise.resolve(this.resolve()).then(resolve, reject)
  }

  private rows() {
    let rows = (this.store[this.table] ?? []).slice()
    for (const [t, col, val] of this.filters) {
      if (t === 'eq') rows = rows.filter((r) => r[col] === val)
      else if (t === 'is') rows = rows.filter((r) => (r[col] ?? null) === val)
      else if (t === 'in') rows = rows.filter((r) => (val as any[]).includes(r[col]))
      else if (t === 'lte') rows = rows.filter((r) => r[col] <= val)
    }
    if (this._order) {
      const { col, ascending } = this._order
      rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0))
      if (!ascending) rows.reverse()
    }
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1)
    if (this._limit != null) rows = rows.slice(0, this._limit)
    return rows
  }

  private resolve() {
    if (this.op === 'select') {
      const rows = this.rows()
      if (this._count) {
        if (this.store.__failCount?.[this.table]) return { data: null, count: null, error: { code: 'XX', message: 'count fail' } }
        const matchFilter = this.filters.find(([t, col]) => t === 'eq' && col === 'match_id')
        if (matchFilter && this.store.__failCountMatch?.has(matchFilter[2])) {
          return { data: null, count: null, error: { code: 'XX', message: 'count fail' } }
        }
        return { data: this._head ? null : rows, count: rows.length, error: null }
      }
      if (this._single) {
        if (this.store.__failSingle?.[this.table]) return { data: null, error: { code: 'XX', message: 'single fail' } }
        return { data: rows[0] ?? null, error: null }
      }
      if (this.store.__failSelect?.[this.table]) return { data: null, error: { code: 'XX', message: 'select fail' } }
      return { data: rows, error: null }
    }
    if (this.op === 'update') {
      for (const r of this.rows()) Object.assign(r, this._update)
      this.logs.updates.push({ table: this.table, patch: this._update, filters: this.filters })
      return { data: null, error: null }
    }
    // insert
    const row = this._insert
    if (this.table === 'swipes') {
      const dup = (this.store.swipes ?? []).some(
        (s) => s.swiper_id === row.swiper_id && s.swiped_id === row.swiped_id,
      )
      if (dup) return { data: null, error: { code: '23505', message: 'dup swipe' } }
      ;(this.store.swipes ??= []).push({ ...row })
    } else if (this.table === 'matches') {
      const dup = (this.store.matches ?? []).some(
        (m) => m.user1_id === row.user1_id && m.user2_id === row.user2_id,
      )
      if (dup) return { data: null, error: { code: '23505', message: 'dup match' } }
      const id = `match-${(this.store.matches?.length ?? 0) + 1}`
      ;(this.store.matches ??= []).push({ id, ...row })
      ;(this.logs.inserts.matches ??= []).push({ id, ...row })
      return this._selected ? { data: { id }, error: null } : { data: null, error: null }
    } else {
      ;(this.store[this.table] ??= []).push({ ...row })
    }
    ;(this.logs.inserts[this.table] ??= []).push({ ...row })
    if (this.store.__failInsert?.[this.table]) return { data: null, error: { code: 'XX', message: 'forced' } }
    return { data: null, error: null }
  }
}

function useStore(store: Store): Logs {
  const logs: Logs = { inserts: {}, updates: [] }
  vi.mocked(db.from).mockImplementation((table: string) => new QB(table, store, logs) as any)
  return logs
}

// --- data builders --------------------------------------------------------
const OLD = '2020-01-01T00:00:00Z'
const RECENT = new Date().toISOString()
const STALE = new Date(Date.now() - 30 * 60 * 1000).toISOString()

function mkUser(id: string, o: Partial<any> = {}) {
  return {
    id, name: `U-${id}`, is_seed: false, gender: 'man', looking_for: 'women',
    location: null, is_active: true, banned_at: null, deleted_at: null,
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

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------

describe('runFakeLikerJob — config gating', () => {
  it('returns { skipped: "disabled" } and writes no run row when disabled', async () => {
    const store: Store = { fake_liker_config: [{ id: true, enabled: false, max_targets_per_run: 100 }] }
    const logs = useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toEqual({ skipped: 'disabled' })
    expect(logs.inserts.fake_liker_runs).toBeUndefined()
  })

  it('returns { skipped: "disabled" } when the config row is missing', async () => {
    const store: Store = { fake_liker_config: [] }
    const logs = useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toEqual({ skipped: 'disabled' })
    expect(logs.inserts.fake_liker_runs).toBeUndefined()
  })
})

describe('runFakeLikerJob — fake pool', () => {
  it('records a zeroed run and finishes when the fake pool is empty', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkUser('t1', { created_at: OLD })], // real user, no fakes
    }
    const logs = useStore(store)
    const res = await runFakeLikerJob('schedule', silent)
    expect(res).toMatchObject({ likesSent: 0, matchesCreated: 0, salamsSent: 0 })
    expect(logs.inserts.fake_liker_runs).toHaveLength(1)
    expect(logs.inserts.fake_liker_runs[0]).toMatchObject({ likes_sent: 0, matches_created: 0 })
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    // only 'ok' should be liked
    expect(res.likesSent).toBe(1)
    expect(logs.inserts.swipes.map((s: any) => s.swiped_id)).toEqual(['ok'])
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(1)
    expect(logs.inserts.swipes.map((s: any) => s.swiped_id)).toEqual(['man'])
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
    const logs = useStore(store)
    await runFakeLikerJob('schedule', silent)
    const pairs = logs.inserts.swipes.map((s: any) => [s.swiper_id, s.swiped_id])
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
    const logs = useStore(store)
    await runFakeLikerJob('schedule', silent)
    expect(logs.inserts.swipes.map((s: any) => [s.swiper_id, s.swiped_id])).toEqual([['B', 't1']])
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
    useStore(store)
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
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 555, last_active: RECENT }),
      ],
      // target already liked the fake → reverse like present
      swipes: [{ swiper_id: 't1', swiped_id: 'f1', direction: 'like' }],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.matchesCreated).toBe(1)
    // sorted: 'f1' < 't1'
    expect(logs.inserts.matches[0]).toMatchObject({ user1_id: 'f1', user2_id: 't1' })
    expect(notifyMatch).toHaveBeenCalledTimes(1)
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 555, matchName: 'Sara', matchPhoto: 'https://p/f1.jpg' },
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
    useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.matchesCreated).toBe(0)
    expect(res.likesSent).toBe(1)
    expect(notifyMatch).not.toHaveBeenCalled()
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
    useStore(store)
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
        mkUser('r1', { gender: 'man', looking_for: 'both', telegram_id: 777, last_active: RECENT }),
      ],
      // r1 liked f2 specifically (not f1)
      swipes: [{ swiper_id: 'r1', swiped_id: 'f2', direction: 'like' }],
      user_photos: [{ user_id: 'f2', url: 'https://p/f2.jpg', position: 0 }],
    }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.matchesCreated).toBe(1)
    // f2 (the liked fake) likes r1 back — never f1
    expect(logs.inserts.swipes).toEqual([{ swiper_id: 'f2', swiped_id: 'r1', direction: 'like' }])
    expect(logs.inserts.matches[0]).toMatchObject({ user1_id: 'f2', user2_id: 'r1' }) // 'f2' < 'r1'
    expect(notifyMatch).toHaveBeenCalledWith([
      { telegramId: 777, matchName: 'Bea', matchPhoto: 'https://p/f2.jpg' },
    ])
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.matchesCreated).toBe(1)
    expect(logs.inserts.matches[0]).toMatchObject({ user1_id: 'f1', user2_id: 'r1' })
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.matchesCreated).toBe(0)
    expect(logs.inserts.swipes).toBeUndefined() // no new like inserted at all
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.likesSent).toBe(1)
    // budget is exhausted by the warm lead → 'cold' is never liked this run
    expect(logs.inserts.swipes.map((s: any) => s.swiped_id)).toEqual(['warm'])
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any

    expect(res.likesSent).toBe(0)
    expect(res.matchesCreated).toBe(0)
    expect(logs.inserts.swipes).toBeUndefined()
  })
})

describe('runFakeLikerJob — new-like notification', () => {
  it('DMs a real target when the fake likes them with no reverse like', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1', { name: 'Sara' }),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: 777 }),
      ],
      user_photos: [{ user_id: 'f1', url: 'https://p/f1.jpg', position: 0 }],
    }
    useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    await flush()

    expect(res.likesSent).toBe(1)
    expect(res.matchesCreated).toBe(0)
    expect(notifyNewLike).toHaveBeenCalledWith(777, 'Sara')
  })

  it('does not notify when the target has a fake/sentinel telegram id', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [
        mkFake('f1'),
        mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both', telegram_id: -5 }),
      ],
    }
    useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()

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
    useStore(store)
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect(logs.inserts.messages).toEqual([{ match_id: 'm1', sender_id: 'f1', body: 'salam' }])
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
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
  })

  it('does not salam a both-fake match even if it has zero messages', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkFake('f2')],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'f2' }],
    }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect(logs.inserts.messages).toBeUndefined()
  })

  it('orders the salam match queries by created_at descending', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('r1', { looking_for: 'men', created_at: OLD, last_active: RECENT })],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1', created_at: OLD }],
    }
    useStore(store)
    const orders: Array<{ col: string; ascending: boolean }> = []
    const realFrom = vi.mocked(db.from).getMockImplementation()!
    vi.mocked(db.from).mockImplementation((table: string) => {
      const qb = realFrom(table) as any
      const origOrder = qb.order.bind(qb)
      qb.order = (col: string, opts?: { ascending?: boolean }) => {
        if (table === 'matches') orders.push({ col, ascending: opts?.ascending !== false })
        return origOrder(col, opts)
      }
      return qb
    })
    await runFakeLikerJob('schedule', silent)
    // both user1_id and user2_id match queries must order created_at desc
    expect(orders).toEqual([
      { col: 'created_at', ascending: false },
      { col: 'created_at', ascending: false },
    ])
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
      const created = `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
      users.push(mkUser(rid, { looking_for: 'men', created_at: OLD, last_active: RECENT }))
      matches.push({ id: `m${i}`, user1_id: 'f1', user2_id: rid, created_at: created })
      // every match EXCEPT the newest already has a message
      if (i !== CAP + 49) messages.push({ match_id: `m${i}`, sender_id: rid, body: 'hey' })
    }
    const store: Store = { fake_liker_config: enabledConfig(), users, matches, messages }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect(logs.inserts.messages).toEqual([{ match_id: `m${CAP + 49}`, sender_id: 'f1', body: 'salam' }])
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
    const logs = useStore(store)
    await runFakeLikerJob('schedule', silent)
    await flush()
    return logs
  }

  it('notifies an offline, eligible real user and stamps notified_offline_at', async () => {
    const logs = await runWithReal({ last_active: STALE, notified_offline_at: null, telegram_id: 777, allows_write_to_pm: null })
    expect(notifyNewMessage).toHaveBeenCalledWith(777, 'Sara', 'salam', 'https://p/f1.jpg')
    const stamp = logs.updates.find((u) => u.table === 'users' && 'notified_offline_at' in u.patch)
    expect(stamp).toBeTruthy()
    expect(stamp!.filters).toContainEqual(['eq', 'id', 'r1'])
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('manual', silent)) as any
    const row = logs.inserts.fake_liker_runs[0]
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

describe('runFakeLikerJob — error handling (supabase-js resolves, never throws)', () => {
  const realOpts = { looking_for: 'men', created_at: OLD }

  it('seeds counters via head-count queries, not a raw-row fetch', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('A'), mkFake('B'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      swipes: [
        { swiper_id: 'A', swiped_id: 'x', direction: 'like' },
        { swiper_id: 'A', swiped_id: 'y', direction: 'like' },
      ],
    }
    const logs = useStore(store)
    const seedSelects: Array<{ head?: boolean }> = []
    const realFrom = vi.mocked(db.from).getMockImplementation()!
    vi.mocked(db.from).mockImplementation((table: string) => {
      const qb = realFrom(table) as any
      const origSelect = qb.select.bind(qb)
      qb.select = (cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (table === 'swipes' && opts?.count) seedSelects.push({ head: opts.head })
        return origSelect(cols, opts)
      }
      return qb
    })
    await runFakeLikerJob('schedule', silent)
    // A had 2 historical likes → B (0) wins the like; and the seeding used head counts.
    expect(seedSelects.length).toBeGreaterThanOrEqual(2)
    expect(seedSelects.every((s) => s.head === true)).toBe(true)
    expect(logs.inserts.swipes.map((s: any) => [s.swiper_id, s.swiped_id])).toEqual([['B', 't1']])
  })

  it('zeroes a fake counter and warns when the counter head-count errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('A'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      __failCount: { swipes: true },
    }
    const logs = useStore(store)
    const logger = mkLogger()
    const res = (await runFakeLikerJob('schedule', logger)) as any
    // Counter zeroed on error → the fake still likes; a warn is logged.
    expect(res.likesSent).toBe(1)
    expect(logs.inserts.swipes.map((s: any) => s.swiped_id)).toEqual(['t1'])
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ fake: 'A' }), expect.stringContaining('counter seed'))
  })

  it('skips a whole candidate batch (no likes) when the received-like fetch errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('ok', { created_at: OLD, gender: 'man', looking_for: 'both' })],
      __failSelect: { swipes: true },
    }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect(logs.inserts.swipes).toBeUndefined()
  })

  it('pages the received-like lookup beyond one page (page-size boundary)', async () => {
    // One eligible candidate 'c1' with exactly PAGE_SIZE (1000) received likes → the
    // first page fills to the cap, so a second `.range()` page must be requested.
    const users: any[] = [mkFake('f1'), mkUser('c1', { created_at: OLD, gender: 'man', looking_for: 'both' })]
    const swipes: any[] = []
    for (let i = 0; i < 1000; i++) swipes.push({ swiper_id: `s${i}`, swiped_id: 'c1', direction: 'like' })
    const store: Store = { fake_liker_config: enabledConfig(), users, swipes }
    useStore(store)
    const ranges: Array<[number, number]> = []
    const realFrom = vi.mocked(db.from).getMockImplementation()!
    vi.mocked(db.from).mockImplementation((table: string) => {
      const qb = realFrom(table) as any
      const origRange = qb.range.bind(qb)
      qb.range = (from: number, to: number) => {
        if (table === 'swipes') ranges.push([from, to])
        return origRange(from, to)
      }
      return qb
    })
    await runFakeLikerJob('schedule', silent)
    // Page 1 was full (1000) so page 2 was requested.
    expect(ranges).toContainEqual([0, 999])
    expect(ranges).toContainEqual([1000, 1999])
  })

  it('sends no salam (and counts errors) when every message-count query errors', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('r1', { ...realOpts, last_active: RECENT })],
      matches: [{ id: 'm1', user1_id: 'f1', user2_id: 'r1' }],
      __failCount: { messages: true },
    }
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect(logs.inserts.messages).toBeUndefined()
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.salamsSent).toBe(1)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect(logs.inserts.messages).toEqual([{ match_id: 'm1', sender_id: 'f1', body: 'salam' }])
  })

  it('warns when the run-row insert errors (supabase-js resolves it, not throws)', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1')],
      __failInsert: { fake_liker_runs: true },
    }
    useStore(store)
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
    const logs = useStore(store)
    const res = (await runFakeLikerJob('schedule', silent)) as any
    expect(res.likesSent).toBe(1)
    expect(res.matchesCreated).toBe(0)
    expect(res.errors).toBeGreaterThanOrEqual(1)
    expect(logs.inserts.matches).toBeUndefined()
  })
})

describe('runFakeLikerJob — concurrency guard', () => {
  it('a second concurrent run returns { skipped: "already_running" }', async () => {
    const store: Store = {
      fake_liker_config: enabledConfig(),
      users: [mkFake('f1'), mkUser('t1', { created_at: OLD, gender: 'man', looking_for: 'both' })],
    }
    useStore(store)
    const p1 = runFakeLikerJob('schedule', silent)
    const p2 = runFakeLikerJob('manual', silent)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r2).toEqual({ skipped: 'already_running' })
    expect(r1).toMatchObject({ likesSent: expect.any(Number) })
  })
})
