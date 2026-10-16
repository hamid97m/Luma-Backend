import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { isSignupComplete } from '../src/users/accountStatus.js'

describe('isSignupComplete', () => {
  const ready = { age: 25, location: 'Tehran' }

  it('is complete with an age, a city, and at least one photo', () => {
    expect(isSignupComplete(ready, 1)).toBe(true)
  })

  it('stays incomplete with no photo', () => {
    expect(isSignupComplete(ready, 0)).toBe(false)
  })

  it('stays incomplete with no city', () => {
    expect(isSignupComplete({ age: 25, location: null }, 1)).toBe(false)
    expect(isSignupComplete({ age: 25, location: '  ' }, 1)).toBe(false)
  })

  it('stays incomplete before an age is chosen', () => {
    expect(isSignupComplete({ age: 0, location: 'Tehran' }, 1)).toBe(false)
    expect(isSignupComplete({ age: null, location: 'Tehran' }, 1)).toBe(false)
  })
})
