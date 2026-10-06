import { describe, it, expect } from 'vitest'
import { interleaveBatch, shuffle, isSameCity } from '../src/discoveryRanking.js'

const p = (id: string) => ({ id })
const ids = (arr: { id: string }[]) => arr.map((x) => x.id)

const POSITIONS = [0, 2, 4, 6]

describe('interleaveBatch', () => {
  it('places likers at positions 0, 2, 4, 6 with fillers between', () => {
    const likers = [p('L1'), p('L2'), p('L3'), p('L4')]
    const city = [p('C1'), p('C2'), p('C3')]
    const rest = [p('R1'), p('R2'), p('R3')]
    const out = interleaveBatch(likers, [city, rest], 10, POSITIONS)
    expect(ids(out)).toEqual(['L1', 'C1', 'L2', 'C2', 'L3', 'C3', 'L4', 'R1', 'R2', 'R3'])
  })

  it('fills same-city before rest in non-liker slots', () => {
    const out = interleaveBatch([], [[p('C1'), p('C2')], [p('R1')]], 10, POSITIONS)
    expect(ids(out)).toEqual(['C1', 'C2', 'R1'])
  })

  it('leaves no gaps when there are fewer likers than positions', () => {
    const out = interleaveBatch([p('L1')], [[p('C1')], [p('R1'), p('R2')]], 10, POSITIONS)
    expect(ids(out)).toEqual(['L1', 'C1', 'R1', 'R2'])
  })

  it('returns remaining likers when fillers run out', () => {
    const out = interleaveBatch([p('L1'), p('L2'), p('L3')], [[p('C1')], []], 10, POSITIONS)
    // L1 at 0, C1 at 1, L2 at 2, fillers exhausted → L3 follows immediately
    expect(ids(out)).toEqual(['L1', 'C1', 'L2', 'L3'])
  })

  it('dedupes across tiers, keeping the highest tier (liker wins)', () => {
    const dup = p('X')
    const out = interleaveBatch([dup], [[p('X'), p('C1')], [p('X'), p('R1')]], 10, POSITIONS)
    expect(ids(out)).toEqual(['X', 'C1', 'R1'])
  })

  it('truncates to batchSize', () => {
    const rest = Array.from({ length: 15 }, (_, i) => p(`R${i}`))
    const out = interleaveBatch([], [[], rest], 10, POSITIONS)
    expect(out).toHaveLength(10)
  })

  it('returns empty array when all tiers are empty', () => {
    expect(interleaveBatch([], [[], []], 10, POSITIONS)).toEqual([])
  })

  it('fills same-city, then same-country, then rest', () => {
    const out = interleaveBatch([], [[p('C1')], [p('N1'), p('N2')], [p('R1')]], 10, POSITIONS)
    expect(ids(out)).toEqual(['C1', 'N1', 'N2', 'R1'])
  })
})

describe('isSameCity', () => {
  it('matches on the normalized city and country', () => {
    expect(isSameCity({ geo_city: 'Tehran', geo_country: 'IR' }, { geo_city: 'Tehran', geo_country: 'IR' })).toBe(true)
  })

  it('does not match the same city name in a different country', () => {
    expect(isSameCity({ geo_city: 'Paris', geo_country: 'FR' }, { geo_city: 'Paris', geo_country: 'US' })).toBe(false)
  })

  it('never matches an unresolved side, even with identical typed text', () => {
    const typedOnly = { location: 'Tehran', geo_city: null, geo_country: null }
    expect(isSameCity(typedOnly, typedOnly)).toBe(false)
    expect(isSameCity(typedOnly, { geo_city: 'Tehran', geo_country: 'IR' })).toBe(false)
  })

  it('never matches on country alone', () => {
    expect(isSameCity({ geo_city: null, geo_country: 'IR' }, { geo_city: null, geo_country: 'IR' })).toBe(false)
  })
})

describe('shuffle', () => {
  it('is a permutation — preserves every element and length', () => {
    const input = Array.from({ length: 50 }, (_, i) => i)
    const out = shuffle([...input])
    expect(out).toHaveLength(input.length)
    expect([...out].sort((a, b) => a - b)).toEqual(input)
  })

  it('handles empty and single-element arrays', () => {
    expect(shuffle([])).toEqual([])
    expect(shuffle(['only'])).toEqual(['only'])
  })
})