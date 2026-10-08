import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { getIncomingLikers, getIncomingLiker } from '../src/likes/service.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

function liker(id: string, gender: string, opts: Partial<{ deleted_at: string; banned_at: string; paused_at: string; premium_until: string | null }> = {}) {
  return {
    swiper_id: id, created_at: `2026-08-0${id.slice(-1)}T00:00:00Z`,
    swiper: { id, name: `U${id}`, age: 25, bio: null, location: 'Tehran', interests: ['Hiking', 'Music'], telegram_id: 10, gender, deleted_at: opts.deleted_at ?? null, banned_at: opts.banned_at ?? null, paused_at: opts.paused_at ?? null, premium_until: opts.premium_until ?? null },
  }
}

// swipes is queried twice (incoming, then outgoing) — serve calls in order.
function mockDb(incoming: any[], outgoing: any[], blocks: any[], matches: any[]) {
  let swipeCall = 0
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'swipes') return chainable({ data: swipeCall++ === 0 ? incoming : outgoing })
    if (table === 'blocks') return chainable({ data: blocks })
    if (table === 'matches') return chainable({ data: matches })
    return chainable({ data: null })
  })
}

describe('getIncomingLikers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns likers not yet acted on, newest first', async () => {
    mockDb([liker('a1', 'woman'), liker('a2', 'man', { premium_until: '2099-01-01T00:00:00.000Z' })], [], [], [])
    const res = await getIncomingLikers('me')
    expect(res.map((r) => r.id)).toEqual(['a2', 'a1']) // created_at desc
    expect(res[0].gender).toBe('man')
    expect(res[0].premium).toBe(true)
    expect(res[1].premium).toBe(false)
    // location + interests are carried through for the liker profile view
    expect(res[0].location).toBe('Tehran')
    expect(res[0].interests).toEqual(['Hiking', 'Music'])
  })

  it('excludes people I already swiped', async () => {
    mockDb([liker('a1', 'woman')], [{ swiped_id: 'a1' }], [], [])
    expect(await getIncomingLikers('me')).toEqual([])
  })

  it('excludes matched partners', async () => {
    mockDb([liker('a1', 'woman')], [], [], [{ user1_id: 'me', user2_id: 'a1' }])
    expect(await getIncomingLikers('me')).toEqual([])
  })

  it('excludes blocked, deleted, banned, and paused likers', async () => {
    mockDb(
      [liker('a1', 'woman'), liker('a2', 'man', { deleted_at: 'x' }), liker('a3', 'man', { banned_at: 'x' }), liker('a4', 'woman', { paused_at: 'x' })],
      [], [{ blocker_id: 'me', blocked_id: 'a1' }], [],
    )
    expect(await getIncomingLikers('me')).toEqual([])
  })
})

describe('getIncomingLiker', () => {
  beforeEach(() => vi.clearAllMocks())

  // swipes is queried twice (his like, then my swipe on him).
  function mockPair(like: any[], mine: any[], blocks: any[], matches: any[]) {
    let swipeCall = 0
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'swipes') return chainable({ data: swipeCall++ === 0 ? like : mine })
      if (table === 'blocks') return chainable({ data: blocks })
      if (table === 'matches') return chainable({ data: matches })
      return chainable({ data: null })
    })
  }

  it('returns the one liker in the IncomingLiker shape, with likedAt', async () => {
    mockPair([liker('a2', 'man', { premium_until: '2099-01-01T00:00:00.000Z' })], [], [], [])
    const res = await getIncomingLiker('me', 'a2')
    expect(res).toEqual({
      id: 'a2', name: 'Ua2', age: 25, bio: null, location: 'Tehran', interests: ['Hiking', 'Music'],
      telegramId: 10, gender: 'man', likedAt: '2026-08-02T00:00:00Z', premium: true,
    })
  })

  it('returns null with no like row', async () => {
    mockPair([], [], [], [])
    expect(await getIncomingLiker('me', 'a1')).toBeNull()
  })

  it.each([
    ['deleted', [liker('a1', 'man', { deleted_at: 'x' })], [], [], []],
    ['banned', [liker('a1', 'man', { banned_at: 'x' })], [], [], []],
    ['paused', [liker('a1', 'man', { paused_at: 'x' })], [], [], []],
    ['already swiped by her', [liker('a1', 'man')], [{ swiped_id: 'a1' }], [], []],
    ['blocked either way', [liker('a1', 'man')], [], [{ blocker_id: 'a1', blocked_id: 'me' }], []],
    ['already matched', [liker('a1', 'man')], [], [], [{ user1_id: 'a1', user2_id: 'me' }]],
  ])('returns null when %s', async (_name, like, mine, blocks, matches) => {
    mockPair(like as any[], mine as any[], blocks as any[], matches as any[])
    expect(await getIncomingLiker('me', 'a1')).toBeNull()
  })
})
