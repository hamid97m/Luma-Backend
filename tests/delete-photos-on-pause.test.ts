import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

import { deleteAllPhotosForUser } from '../src/photos/deleteAllPhotosForUser.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { photoFileExists, seedPhotoFile, withMissingTable } from './helpers/profile.js'

describe('deleteAllPhotosForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes storage objects and deletes the user_photos rows when photos exist', async () => {
    const u = await createUser()
    const other = await createUser()
    const a = await createPhoto(u.id, 0)
    const b = await createPhoto(u.id, 1)
    const c = await createPhoto(other.id, 0)
    await seedPhotoFile(u.id, a.id)
    await seedPhotoFile(u.id, b.id)
    await seedPhotoFile(other.id, c.id)

    await deleteAllPhotosForUser(u.id)

    expect(photoFileExists(u.id, a.id)).toBe(false)
    expect(photoFileExists(u.id, b.id)).toBe(false)
    expect(photoFileExists(other.id, c.id)).toBe(true)
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${u.id}`)[0].n).toBe(0)
    // Other users' photos are untouched.
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${other.id}`)[0].n).toBe(1)
  })

  it('does nothing when the user has no photos', async () => {
    const u = await createUser()
    const other = await createUser()
    const c = await createPhoto(other.id, 0)
    await seedPhotoFile(other.id, c.id)

    await expect(deleteAllPhotosForUser(u.id)).resolves.toBeUndefined()

    expect(photoFileExists(other.id, c.id)).toBe(true)
  })

  it('still deletes the rows when a photo file is already gone', async () => {
    const u = await createUser()
    await createPhoto(u.id, 0) // no file on disk

    await deleteAllPhotosForUser(u.id)

    expect((await sql`select count(*)::int as n from user_photos where user_id = ${u.id}`)[0].n).toBe(0)
  })

  it('still deletes the rows when the files cannot be removed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    const a = await createPhoto(u.id, 0)
    await seedPhotoFile(u.id, a.id)
    const userDir = join(process.env.MEDIA_DIR!, 'public', 'profile-photos', u.id)
    await chmod(userDir, 0o500) // unlink fails with EACCES
    try {
      await expect(deleteAllPhotosForUser(u.id)).resolves.toBeUndefined()
    } finally {
      await chmod(userDir, 0o700)
    }
    expect((await sql`select count(*)::int as n from user_photos where user_id = ${u.id}`)[0].n).toBe(0)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
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
