import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { getIncomingLikers } from '../src/likes/service.js'
import { db } from '../src/db.js'
import { chainable } from './admin-helpers.js'

function liker(id: string, gender: string, opts: Partial<{ deleted_at: string; banned_at: string }> = {}) {
  return {
    swiper_id: id, created_at: `2026-08-0${id.slice(-1)}T00:00:00Z`,
    swiper: { id, name: `U${id}`, age: 25, bio: null, location: 'Tehran', interests: ['Hiking', 'Music'], telegram_id: 10, gender, deleted_at: opts.deleted_at ?? null, banned_at: opts.banned_at ?? null },
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
    mockDb([liker('a1', 'woman'), liker('a2', 'man')], [], [], [])
    const res = await getIncomingLikers('me')
    expect(res.map((r) => r.id)).toEqual(['a2', 'a1']) // created_at desc
    expect(res[0].gender).toBe('man')
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

  it('excludes blocked, deleted, and banned likers', async () => {
    mockDb(
      [liker('a1', 'woman'), liker('a2', 'man', { deleted_at: 'x' }), liker('a3', 'man', { banned_at: 'x' })],
      [], [{ blocker_id: 'me', blocked_id: 'a1' }], [],
    )
    expect(await getIncomingLikers('me')).toEqual([])
  })
})
