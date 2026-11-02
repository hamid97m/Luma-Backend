import { describe, it, expect, vi, beforeEach } from 'vitest'

import { isSignupComplete, markActiveIfSignupComplete } from '../src/users/accountStatus.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { withFailingWrites } from './helpers/profile.js'

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

describe('markActiveIfSignupComplete', () => {
  beforeEach(async () => { await resetDb() })

  const statusOf = async (id: string) =>
    (await sql`select account_status from users where id = ${id}`)[0].account_status

  it('promotes a preparing account once age, city and a photo are in', async () => {
    const u = await createUser({ account_status: 'preparing', age: 25, location: 'Tehran' })
    await markActiveIfSignupComplete(u.id, { ...u, account_status: 'preparing' }, 1)
    expect(await statusOf(u.id)).toBe('active')
  })

  it('leaves an incomplete signup preparing', async () => {
    const u = await createUser({ account_status: 'preparing', age: 25, location: 'Tehran' })
    await markActiveIfSignupComplete(u.id, u, 0)
    expect(await statusOf(u.id)).toBe('preparing')
  })

  it('only flips rows that are still preparing (guarded update)', async () => {
    // Caller passes a stale snapshot; the row itself is already active → no-op, no error.
    const u = await createUser({ account_status: 'active', age: 25, location: 'Tehran' })
    await markActiveIfSignupComplete(u.id, { ...u, account_status: 'preparing' }, 1)
    expect(await statusOf(u.id)).toBe('active')
  })

  it('logs and swallows a failed write', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser({ account_status: 'preparing', age: 25, location: 'Tehran' })
    await withFailingWrites('users', 'update', () =>
      expect(markActiveIfSignupComplete(u.id, u, 1)).resolves.toBeUndefined())
    expect(errorSpy).toHaveBeenCalled()
    expect(await statusOf(u.id)).toBe('preparing')
    errorSpy.mockRestore()
  })
})
