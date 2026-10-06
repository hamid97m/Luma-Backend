import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/likes/reveal.js', () => ({
  ensureDailyReveal: vi.fn().mockResolvedValue({ applies: true, swiperId: 'ali' }),
}))

import { db } from '../src/db.js'
import { ensureDailyReveal } from '../src/likes/reveal.js'
import { runLikeRevealJob } from '../src/jobs/likeReveal.js'
import { chainable } from './admin-helpers.js'

describe('runLikeRevealJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls ensureDailyReveal once per woman who has an incoming like', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'swipes') return chainable({
        data: [
          { swiped_id: 'w1', swiped: { gender: 'woman', deleted_at: null, banned_at: null } },
          { swiped_id: 'w1', swiped: { gender: 'woman', deleted_at: null, banned_at: null } },
          { swiped_id: 'm1', swiped: { gender: 'man', deleted_at: null, banned_at: null } },
          { swiped_id: 'w2', swiped: { gender: 'woman', deleted_at: 'x', banned_at: null } },
        ],
      })
      return chainable({ data: [] })
    })
    const result = await runLikeRevealJob(new Date('2026-10-07T14:30:00.000Z'))
    expect(result.considered).toBe(1)
    expect(ensureDailyReveal).toHaveBeenCalledTimes(1)
    expect(ensureDailyReveal).toHaveBeenCalledWith('w1', new Date('2026-10-07T14:30:00.000Z'))
  })
})
