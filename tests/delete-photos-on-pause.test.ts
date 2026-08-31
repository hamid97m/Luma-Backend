import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { db } from '../src/db.js'
import { deleteAllPhotosForUser } from '../src/photos/deleteAllPhotosForUser.js'

const USER_ID = 'user-1'

describe('deleteAllPhotosForUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes storage objects and deletes the user_photos rows when photos exist', async () => {
    const photos = [{ id: 'photo-a' }, { id: 'photo-b' }]
    const select = vi.fn(() => ({ eq: () => ({ data: photos, error: null }) }))
    const del = vi.fn(() => ({ eq: () => ({ error: null }) }))
    vi.mocked(db.from).mockImplementation(() => ({ select, delete: del } as any))
    const remove = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.storage.from).mockImplementation(() => ({ remove } as any))

    await deleteAllPhotosForUser(USER_ID)

    expect(db.storage.from).toHaveBeenCalledWith('profile-photos')
    expect(remove).toHaveBeenCalledWith(['user-1/photo-a', 'user-1/photo-b'])
    expect(del).toHaveBeenCalled()
  })

  it('does nothing when the user has no photos', async () => {
    const select = vi.fn(() => ({ eq: () => ({ data: [], error: null }) }))
    const del = vi.fn(() => ({ eq: () => ({ error: null }) }))
    vi.mocked(db.from).mockImplementation(() => ({ select, delete: del } as any))
    const remove = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.storage.from).mockImplementation(() => ({ remove } as any))

    await deleteAllPhotosForUser(USER_ID)

    expect(remove).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('swallows errors and never throws', async () => {
    vi.mocked(db.from).mockImplementation(() => { throw new Error('boom') })

    await expect(deleteAllPhotosForUser(USER_ID)).resolves.toBeUndefined()
  })
})
