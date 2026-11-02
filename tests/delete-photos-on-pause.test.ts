import { describe, it, expect, vi, beforeEach } from 'vitest'

// Storage still goes through supabase-js; the DB part is real Postgres.
vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))

import { db } from '../src/db.js'
import { deleteAllPhotosForUser } from '../src/photos/deleteAllPhotosForUser.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { storageMock, withMissingTable } from './helpers/profile.js'

describe('deleteAllPhotosForUser', () => {
  let storage: ReturnType<typeof storageMock>
  beforeEach(async () => {
    await resetDb()
    storage = storageMock()
    vi.mocked(db.storage.from).mockReturnValue(storage as any)
  })

  it('removes storage objects and deletes the user_photos rows when photos exist', async () => {
    const u = await createUser()
    const other = await createUser()
    const a = await createPhoto(u.id, 0)
    const b = await createPhoto(u.id, 1)
    await createPhoto(other.id, 0)

    await deleteAllPhotosForUser(u.id)

    expect(db.storage.from).toHaveBeenCalledWith('profile-photos')
    expect(storage.remove).toHaveBeenCalledTimes(1)
    expect([...storage.remove.mock.calls[0][0]].sort()).toEqual([`${u.id}/${a.id}`, `${u.id}/${b.id}`].sort())
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${u.id}`)[0].n).toBe(0)
    // Other users' photos are untouched.
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${other.id}`)[0].n).toBe(1)
  })

  it('does nothing when the user has no photos', async () => {
    const u = await createUser()

    await deleteAllPhotosForUser(u.id)

    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('swallows errors and never throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    await withMissingTable('user_photos', () =>
      expect(deleteAllPhotosForUser(u.id)).resolves.toBeUndefined())
    // Malformed id → Postgres 22P02 thrown → still swallowed.
    await expect(deleteAllPhotosForUser('user-1')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
