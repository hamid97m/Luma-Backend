import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(() => Promise.resolve()) }))
// Cross-area (photos + storage); asserted as a call, its own tests cover the deletion.
vi.mock('../src/photos/deleteAllPhotosForUser.js', () => ({ deleteAllPhotosForUser: vi.fn(() => Promise.resolve()) }))

import { buildApp } from '../src/server.js'
import { notifyPaused } from '../src/bot.js'
import { deleteAllPhotosForUser } from '../src/photos/deleteAllPhotosForUser.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('admin pause/unpause', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const pausedAt = async (id: string) => (await sql`select paused_at from users where id = ${id}`)[0].paused_at

  it('pauses a user, sets paused_at, deletes their photos, and DMs them in their language', async () => {
    const u = await createUser({ telegram_id: 100, allows_write_to_pm: true, locale: 'en' })

    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/pause`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await pausedAt(u.id)).toBeTruthy()
    expect(notifyPaused).toHaveBeenCalledWith(100, 'en')
    expect(deleteAllPhotosForUser).toHaveBeenCalledWith(u.id)
  })

  it('DMs a user with no stored locale with a null locale (Persian)', async () => {
    const u = await createUser({ telegram_id: 101, allows_write_to_pm: true })
    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/pause`, headers })
    expect(res.statusCode).toBe(200)
    expect(notifyPaused).toHaveBeenCalledWith(101, null)
  })

  it('does not DM a user who declined bot DMs, or a seed (non-positive telegram_id)', async () => {
    const optedOut = await createUser({ allows_write_to_pm: false })
    const seed = await createUser({ telegram_id: -5, is_seed: true })
    for (const u of [optedOut, seed]) {
      const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/pause`, headers })
      expect(res.statusCode).toBe(200)
    }
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('unpauses a user (clears paused_at, no DM, no photo deletion)', async () => {
    const u = await createUser({ telegram_id: 100, paused_at: new Date().toISOString() })

    const res = await app.inject({ method: 'POST', url: `/admin/users/${u.id}/unpause`, headers })
    expect(res.statusCode).toBe(200)
    expect(await pausedAt(u.id)).toBeNull()
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(deleteAllPhotosForUser).not.toHaveBeenCalled()
  })

  it('404s when the user does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/00000000-0000-0000-0000-000000000000/pause', headers })
    expect(res.statusCode).toBe(404)
    expect(deleteAllPhotosForUser).not.toHaveBeenCalled()
  })

  it('404s (not 500) for a malformed id', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/users/nope/pause', headers })
    expect(res.statusCode).toBe(404)
  })
})
