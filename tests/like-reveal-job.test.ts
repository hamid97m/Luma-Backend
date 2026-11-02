import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/likes/reveal.js', () => ({
  ensureDailyReveal: vi.fn().mockResolvedValue({ applies: true, swiperId: null }),
}))

import { ensureDailyReveal } from '../src/likes/reveal.js'
import { runLikeRevealJob } from '../src/jobs/likeReveal.js'
import { resetDb, createUser } from './helpers/db.js'
import { like, pass } from './helpers/discovery.js'

const NOW = new Date('2026-10-07T14:30:00.000Z')

describe('runLikeRevealJob', () => {
  beforeEach(async () => {
    await resetDb()
    vi.mocked(ensureDailyReveal).mockResolvedValue({ applies: true, swiperId: null })
  })

  const woman = (extra: Record<string, unknown> = {}) => createUser({ gender: 'woman', looking_for: 'men', ...extra })
  const man = (extra: Record<string, unknown> = {}) => createUser({ gender: 'man', looking_for: 'women', ...extra })

  it('calls ensureDailyReveal once per live woman who has an incoming like', async () => {
    const w1 = await woman()
    const deleted = await woman({ deleted_at: '2026-10-01T00:00:00Z' })
    const banned = await woman({ banned_at: '2026-10-01T00:00:00Z' })
    const passedOnly = await woman()
    const m1 = await man()
    const a = await man()
    const b = await man()
    await like(a, w1)
    await like(b, w1) // two likes, still one call
    await like(a, deleted)
    await like(a, banned)
    await pass(a, passedOnly) // a pass is not an incoming like
    await like(await woman(), m1) // men are never revealed to

    const result = await runLikeRevealJob(NOW)
    expect(result.considered).toBe(1)
    expect(ensureDailyReveal).toHaveBeenCalledTimes(1)
    expect(ensureDailyReveal).toHaveBeenCalledWith(w1.id, NOW)
  })

  it('skips seed women and keeps going when one ensureDailyReveal throws', async () => {
    const w1 = await woman()
    const seed = await woman({ is_seed: true })
    const w2 = await woman()
    // Swiper order decides processing order (the old (swiper_id, swiped_id) scan).
    const [s1, s2, s3] = (await Promise.all([man(), man(), man()])).sort((x, y) => (x.id < y.id ? -1 : 1))
    await like(s1, w1)
    await like(s2, seed)
    await like(s3, w2)
    vi.mocked(ensureDailyReveal).mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runLikeRevealJob(NOW)
    expect(result.considered).toBe(2)
    expect(ensureDailyReveal).toHaveBeenCalledTimes(2)
    expect(ensureDailyReveal).toHaveBeenNthCalledWith(1, w1.id, NOW)
    expect(ensureDailyReveal).toHaveBeenNthCalledWith(2, w2.id, NOW)
    expect(ensureDailyReveal).not.toHaveBeenCalledWith(seed.id, NOW)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('considers nobody when there are no likes', async () => {
    await woman()
    expect(await runLikeRevealJob(NOW)).toEqual({ considered: 0 })
    expect(ensureDailyReveal).not.toHaveBeenCalled()
  })
})
