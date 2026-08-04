import { describe, it, expect } from 'vitest'
import { computeCharge } from '../src/gifts/pricing.js'

describe('computeCharge', () => {
  it('applies markup and rounds up', () => {
    // 15 * 1.33 = 19.95 -> 20
    expect(computeCharge(15, 33)).toEqual({ chargedStars: 20, markupStars: 5 })
  })
  it('zero markup charges exact cost', () => {
    expect(computeCharge(15, 0)).toEqual({ chargedStars: 15, markupStars: 0 })
  })
  it('override wins over markup', () => {
    expect(computeCharge(15, 33, 25)).toEqual({ chargedStars: 25, markupStars: 10 })
  })
  it('override below cost still yields non-negative markup floor of 0', () => {
    expect(computeCharge(15, 33, 10)).toEqual({ chargedStars: 10, markupStars: 0 })
  })
})
