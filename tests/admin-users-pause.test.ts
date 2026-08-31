import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(() => Promise.resolve()) }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { notifyPaused } from '../src/bot.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin pause/unpause', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('pauses a user, sets paused_at, deletes their photos, and DMs them', async () => {
    const update = vi.fn(() => chainable({ data: { telegram_id: 100, allows_write_to_pm: true }, error: null }))
    const photos = [{ id: 'photo-1' }, { id: 'photo-2' }]
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return { update } as any
      if (table === 'user_photos') return chainable({ data: photos, error: null })
      return chainable({ data: null, error: null })
    })
    const storageRemove = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.storage.from).mockImplementation(() => ({ remove: storageRemove } as any))

    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/pause', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((update.mock.calls[0][0] as any).paused_at).toBeTruthy()
    expect(notifyPaused).toHaveBeenCalledWith(100)
    expect(db.storage.from).toHaveBeenCalledWith('profile-photos')
    expect(storageRemove).toHaveBeenCalledWith(['u1/photo-1', 'u1/photo-2'])
  })

  it('unpauses a user (clears paused_at, no DM, no photo deletion)', async () => {
    const update = vi.fn(() => chainable({ data: { telegram_id: 100, allows_write_to_pm: true }, error: null }))
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return { update } as any
      return chainable({ data: null, error: null })
    })
    const storageRemove = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(db.storage.from).mockImplementation(() => ({ remove: storageRemove } as any))

    const res = await app.inject({ method: 'POST', url: '/admin/users/u1/unpause', headers })
    expect(res.statusCode).toBe(200)
    expect((update.mock.calls[0][0] as any).paused_at).toBeNull()
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(storageRemove).not.toHaveBeenCalled()
  })

  it('404s when the user does not exist', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      ({ update: () => chainable({ data: null, error: { message: 'no rows' } }) } as any))
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/pause', headers })
    expect(res.statusCode).toBe(404)
  })
})
