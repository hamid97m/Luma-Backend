import { describe, it, expect } from 'vitest'
import {
  tehranDate,
  msUntilNextTehranHour,
  pickRevealCandidate,
  isEligibleRevealLiker,
} from '../src/likes/revealPick.js'

describe('tehranDate', () => {
  it('returns the Tehran calendar date', () => {
    // 2026-10-06 21:00 UTC is 2026-10-07 00:30 in Tehran
    expect(tehranDate(new Date('2026-10-06T21:00:00.000Z'))).toBe('2026-10-07')
    expect(tehranDate(new Date('2026-10-06T20:29:00.000Z'))).toBe('2026-10-06')
  })
})

describe('msUntilNextTehranHour', () => {
  it('waits until 18:00 Tehran, including across midnight', () => {
    // 17:00 Tehran = 13:30 UTC
    expect(msUntilNextTehranHour(18, new Date('2026-10-07T13:30:00.000Z'))).toBe(60 * 60 * 1000)
    // 18:30 Tehran = 15:00 UTC → next 18:00 is 23.5h later
    expect(msUntilNextTehranHour(18, new Date('2026-10-07T15:00:00.000Z'))).toBe(23.5 * 60 * 60 * 1000)
  })
})

describe('pickRevealCandidate', () => {
  const viewer = { geoCity: 'Tehran' }
  const older = { id: 'older', geoCity: 'Tehran', lastActive: '2026-10-07T10:00:00.000Z', likedAt: '2026-10-01T00:00:00.000Z' }
  const newer = { id: 'newer', geoCity: 'Tehran', lastActive: '2026-10-07T10:00:00.000Z', likedAt: '2026-10-06T00:00:00.000Z' }
  const active = { id: 'active', geoCity: 'Tehran', lastActive: '2026-10-07T12:00:00.000Z', likedAt: '2026-10-06T00:00:00.000Z' }
  const otherCity = { id: 'shiraz', geoCity: 'Shiraz', lastActive: '2026-10-07T18:00:00.000Z', likedAt: '2026-10-01T00:00:00.000Z' }

  it('prefers the same city, then the more recently active, then the older like', () => {
    expect(pickRevealCandidate(viewer, [newer, older, active, otherCity])?.id).toBe('active')
    expect(pickRevealCandidate(viewer, [newer, older])?.id).toBe('older')
  })

  it('does not apply the city preference when she has no city or nobody shares it', () => {
    expect(pickRevealCandidate({ geoCity: null }, [otherCity, older])?.id).toBe('shiraz')
    expect(pickRevealCandidate({ geoCity: 'Isfahan' }, [otherCity, older])?.id).toBe('shiraz')
  })

  it('returns null for an empty list', () => {
    expect(pickRevealCandidate(viewer, [])).toBeNull()
  })
})

describe('isEligibleRevealLiker', () => {
  const ok = { isSeed: false, pausedAt: null, deletedAt: null, bannedAt: null, photoCount: 1 }

  it('rejects seeds, paused, deleted, banned, and photoless likers', () => {
    expect(isEligibleRevealLiker(ok)).toBe(true)
    expect(isEligibleRevealLiker({ ...ok, isSeed: true })).toBe(false)
    expect(isEligibleRevealLiker({ ...ok, pausedAt: 'x' })).toBe(false)
    expect(isEligibleRevealLiker({ ...ok, deletedAt: 'x' })).toBe(false)
    expect(isEligibleRevealLiker({ ...ok, bannedAt: 'x' })).toBe(false)
    expect(isEligibleRevealLiker({ ...ok, photoCount: 0 })).toBe(false)
  })
})
