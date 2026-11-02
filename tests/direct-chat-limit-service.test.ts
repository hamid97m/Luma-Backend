import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// premium_config belongs to the premium area; pin the toggle per test.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn() }
})

import { isPremiumEnabled } from '../src/premium/service.js'
import {
  DIRECT_CHAT_LIMIT, DIRECT_CHAT_WINDOW_MS,
  directChatLimitApplies, evaluateDirectChatWindow,
  checkAndCountDirectChat, getDirectChatStatus,
} from '../src/premium/directChatLimit.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const NOW = new Date('2026-09-05T12:00:00Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

async function windowOf(userId: string) {
  const [row] = await sql`select direct_chat_window_started_at, direct_chat_window_count from users where id = ${userId}`
  return row
}

/** Simulate a concurrent writer: isPremiumEnabled runs between our read and
 *  our guarded update, so bumping the counter inside it makes the update lose. */
function concurrentBumpTo(userId: string, count: number, after?: () => Promise<unknown>) {
  vi.mocked(isPremiumEnabled).mockImplementationOnce(async () => {
    await sql`update users set direct_chat_window_count = ${count} where id = ${userId}`
    await after?.()
    return true
  })
}

/** Test-only trigger on users: 'skip' silently drops window updates (→ the
 *  guarded update sees 0 rows, i.e. loses), 'fail' raises (→ dbError). */
async function installWindowTrigger(mode: 'skip' | 'fail') {
  const body = mode === 'skip' ? 'return null;' : "raise exception 'boom';"
  await sql.unsafe(`
    create or replace function test_window_guard() returns trigger language plpgsql as $$
    begin
      if new.direct_chat_window_count is distinct from old.direct_chat_window_count then ${body} end if;
      return new;
    end $$;
    drop trigger if exists test_window_guard on users;
    create trigger test_window_guard before update on users for each row execute function test_window_guard();`)
}

afterEach(async () => {
  await sql.unsafe('drop trigger if exists test_window_guard on users; drop function if exists test_window_guard();')
})

const QUOTA_USER = {
  gender: 'man', looking_for: 'women', premium_until: iso(NOW + 86_400_000),
  direct_chat_window_started_at: null, direct_chat_window_count: 0,
}

describe('directChatLimitApplies', () => {
  it('matches the swipe cohort (men and women whose preference includes women)', () => {
    expect(directChatLimitApplies('man', 'women')).toBe(true)
    expect(directChatLimitApplies('man', 'everyone')).toBe(true)
    expect(directChatLimitApplies('woman', 'women')).toBe(true)
    expect(directChatLimitApplies('woman', 'everyone')).toBe(true)
    expect(directChatLimitApplies('woman', 'men')).toBe(false)
    expect(directChatLimitApplies('man', 'men')).toBe(false)
  })
})

describe('evaluateDirectChatWindow', () => {
  it('starts a fresh window on the first direct chat', () => {
    expect(evaluateDirectChatWindow(null, 0, NOW)).toEqual({
      blocked: false, resetAt: iso(NOW + DIRECT_CHAT_WINDOW_MS),
      nextStartedAt: iso(NOW), nextCount: 1, remaining: DIRECT_CHAT_LIMIT - 1,
    })
  })
  it('blocks the 4th within the window', () => {
    const start = iso(NOW - 60_000)
    expect(evaluateDirectChatWindow(start, 2, NOW).remaining).toBe(0)
    expect(evaluateDirectChatWindow(start, 3, NOW)).toEqual({ blocked: true, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
  })
})

describe('checkAndCountDirectChat', () => {
  beforeEach(() => resetDb())

  it('gate=free for a woman seeking only men (never checks the toggle)', async () => {
    const u = await createUser({ ...QUOTA_USER, gender: 'woman', looking_for: 'men' })
    expect(await checkAndCountDirectChat(u.id, NOW)).toEqual({ gate: 'free' })
    expect(isPremiumEnabled).not.toHaveBeenCalled()
    expect((await windowOf(u.id)).direct_chat_window_count).toBe(0)
  })

  it('gate=free when premium toggle is off', async () => {
    const u = await createUser(QUOTA_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(false)
    expect(await checkAndCountDirectChat(u.id, NOW)).toEqual({ gate: 'free' })
  })

  it('gate=paywall for a cohort man who is not premium-active', async () => {
    const u = await createUser({ ...QUOTA_USER, premium_until: null })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await checkAndCountDirectChat(u.id, NOW)).toEqual({ gate: 'paywall' })
  })

  it('gate=quota: counts and returns remaining for a premium cohort man', async () => {
    const u = await createUser(QUOTA_USER)
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await checkAndCountDirectChat(u.id, NOW)
    expect(res).toEqual({ gate: 'quota', blocked: false, remaining: DIRECT_CHAT_LIMIT - 1, resetAt: iso(NOW + DIRECT_CHAT_WINDOW_MS) })
    expect(await windowOf(u.id)).toEqual({ direct_chat_window_started_at: iso(NOW), direct_chat_window_count: 1 })
  })

  it('gate=quota: blocks at the cap without writing', async () => {
    const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: iso(NOW - 60_000), direct_chat_window_count: 3 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await checkAndCountDirectChat(u.id, NOW)).toEqual({ gate: 'quota', blocked: true, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
    expect((await windowOf(u.id)).direct_chat_window_count).toBe(3)
  })

  it('fails open to free when the user row is missing', async () => {
    expect(await checkAndCountDirectChat('00000000-0000-0000-0000-000000000000', NOW)).toEqual({ gate: 'free' })
  })

  it('fails open to free on a db error (malformed id → 22P02 is caught)', async () => {
    expect(await checkAndCountDirectChat('u1', NOW)).toEqual({ gate: 'free' })
  })

  describe('optimistic-concurrency retry', () => {
    const start = iso(NOW - 60_000)

    it('retries and succeeds when the guarded update loses the race once', async () => {
      // Initial read sees count=1; a concurrent writer bumps it to 2 before
      // our guarded update runs, so the first attempt (expecting 1) loses.
      // The retry re-read sees 2, re-evaluates (still under the limit), and
      // the second guarded update (expecting 2) succeeds.
      const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: start, direct_chat_window_count: 1 })
      concurrentBumpTo(u.id, 2)
      const res = await checkAndCountDirectChat(u.id, NOW)
      expect(res).toEqual({
        gate: 'quota', blocked: false,
        remaining: DIRECT_CHAT_LIMIT - 3, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS),
      })
      expect((await windowOf(u.id)).direct_chat_window_count).toBe(3)
    })

    it('fails open when the guarded update loses the race twice', async () => {
      const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: start, direct_chat_window_count: 1 })
      // Bump to 2, then make every later window write a silent no-op (0 rows → lost).
      concurrentBumpTo(u.id, 2, () => installWindowTrigger('skip'))
      const res = await checkAndCountDirectChat(u.id, NOW)
      expect(res).toEqual({
        gate: 'quota', blocked: false,
        remaining: DIRECT_CHAT_LIMIT - 3, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS),
      })
      expect((await windowOf(u.id)).direct_chat_window_count).toBe(2)
    })

    it('blocks when the retry re-read shows the count now at the cap', async () => {
      // Initial read sees count=2 (one direct chat left); a concurrent writer
      // pushes it to the cap (3) before our guarded update lands, so the
      // retry re-evaluation blocks instead of attempting a second update.
      const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: start, direct_chat_window_count: 2 })
      concurrentBumpTo(u.id, 3)
      const res = await checkAndCountDirectChat(u.id, NOW)
      expect(res).toEqual({ gate: 'quota', blocked: true, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
      expect((await windowOf(u.id)).direct_chat_window_count).toBe(3)
    })

    it('fails open (allows) when the first guarded update errors', async () => {
      const u = await createUser(QUOTA_USER)
      await installWindowTrigger('fail')
      vi.mocked(isPremiumEnabled).mockResolvedValue(true)
      const res = await checkAndCountDirectChat(u.id, NOW)
      expect(res).toEqual({
        gate: 'quota', blocked: false,
        remaining: DIRECT_CHAT_LIMIT - 1, resetAt: iso(NOW + DIRECT_CHAT_WINDOW_MS),
      })
      expect((await windowOf(u.id)).direct_chat_window_count).toBe(0)
    })
  })
})

describe('getDirectChatStatus (read-only, never counts)', () => {
  beforeEach(() => resetDb())

  it('reports quota remaining mid-window without writing', async () => {
    const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: iso(NOW - 60_000), direct_chat_window_count: 2 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    const res = await getDirectChatStatus(u.id, NOW)
    expect(res).toEqual({ gate: 'quota', remaining: 1, limit: DIRECT_CHAT_LIMIT, resetAt: iso(NOW - 60_000 + DIRECT_CHAT_WINDOW_MS) })
    expect((await windowOf(u.id)).direct_chat_window_count).toBe(2)
  })

  it('reports a full allowance once the window has expired', async () => {
    const u = await createUser({ ...QUOTA_USER, direct_chat_window_started_at: iso(NOW - DIRECT_CHAT_WINDOW_MS - 1), direct_chat_window_count: 3 })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getDirectChatStatus(u.id, NOW)).toEqual({ gate: 'quota', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null })
  })

  it('reports gate=free with full remaining for a woman seeking only men', async () => {
    const u = await createUser({ ...QUOTA_USER, gender: 'woman', looking_for: 'men' })
    expect(await getDirectChatStatus(u.id, NOW)).toEqual({ gate: 'free', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null })
  })

  it('reports gate=paywall for a non-premium cohort man', async () => {
    const u = await createUser({ ...QUOTA_USER, premium_until: null })
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    expect(await getDirectChatStatus(u.id, NOW)).toEqual({ gate: 'paywall', remaining: DIRECT_CHAT_LIMIT, limit: DIRECT_CHAT_LIMIT, resetAt: null })
  })

  it('fails open to free for a malformed id', async () => {
    expect((await getDirectChatStatus('u1', NOW)).gate).toBe('free')
  })
})
