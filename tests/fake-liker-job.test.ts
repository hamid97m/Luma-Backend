import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewMessage: vi.fn().mockResolvedValue(undefined),
}))

import { db } from '../src/db.js'
import { notifyMatch, notifyNewMessage } from '../src/bot.js'
import { runFakeLikerJob } from '../src/jobs/fakeLiker.js'

// ---------------------------------------------------------------------------
// In-memory Supabase mock: a thenable query builder resolving against seeded
// arrays. Supports exactly the chain methods the job uses. Insert simulates the
// swipes/matches UNIQUE(...) constraints (23505) from the real DB.
// ---------------------------------------------------------------------------

type Store = Record<string, any[]> & { __failInsert?: Record<string, boolean> }
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

  constructor(private table: string, private store: Store, private logs: Logs) {}

  select(_cols?: string) {
    if (this.op === 'insert') this._selected = true
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
      if (this._single) return { data: rows[0] ?? null, error: null }
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
