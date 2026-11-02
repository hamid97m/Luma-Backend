import { describe, it, expect, vi, beforeEach } from 'vitest'

// Storage still goes through supabase-js; the DB part is real Postgres.
vi.mock('../src/db.js', async (orig) => ({ ...(await orig<object>()), db: { storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(), notifyFakePhotoWarning: vi.fn() }))

import { db } from '../src/db.js'
import { notifyFakePhotoWarning, notifyPaused } from '../src/bot.js'
import {
  maybeAutoPauseForReports, maybeWarnFakePhoto, getPhotoReportThreshold, pauseForPhotoReview,
} from '../src/moderation/autoPause.js'
import { resetDb, createUser, createPhoto, sql } from './helpers/db.js'
import { storageMock, createReport, withMissingTable, withFailingWrites } from './helpers/profile.js'

const setThreshold = (n: number) => sql`update moderation_config set photo_report_threshold = ${n} where id = true`
const pausedAt = async (id: string) => (await sql`select paused_at from users where id = ${id}`)[0].paused_at
async function addReports(userId: string, n: number, overrides: Record<string, unknown> = {}) {
  for (let i = 0; i < n; i++) await createReport(userId, overrides)
}

let storage: ReturnType<typeof storageMock>
beforeEach(async () => {
  await resetDb()
  storage = storageMock()
  vi.mocked(db.storage.from).mockReturnValue(storage as any)
})

describe('getPhotoReportThreshold', () => {
  it('reads the singleton config row', async () => {
    await setThreshold(5)
    expect(await getPhotoReportThreshold()).toBe(5)
  })

  it('reads as 0 (off) when the config row is missing or unreadable', async () => {
    await sql`delete from moderation_config`
    expect(await getPhotoReportThreshold()).toBe(0)
    await withMissingTable('moderation_config', async () => expect(await getPhotoReportThreshold()).toBe(0))
  })
})

describe('maybeAutoPauseForReports', () => {
  it('pauses and notifies (in the user\'s language) once the pending count reaches the threshold', async () => {
    const u = await createUser({ telegram_id: 100, allows_write_to_pm: true, locale: 'ar' })
    const p1 = await createPhoto(u.id, 0)
    const p2 = await createPhoto(u.id, 1)
    await setThreshold(3)
    await addReports(u.id, 3, { reason: 'inappropriate' })

    expect(await maybeAutoPauseForReports(u.id)).toBe(true)
    expect(await pausedAt(u.id)).not.toBeNull()
    expect(notifyPaused).toHaveBeenCalledWith(100, 'ar')
    expect(db.storage.from).toHaveBeenCalledWith('profile-photos')
    expect([...storage.remove.mock.calls[0][0]].sort()).toEqual([`${u.id}/${p1.id}`, `${u.id}/${p2.id}`].sort())
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
  })

  it('passes a null locale when the user has not picked a language yet', async () => {
    const u = await createUser({ telegram_id: 100, allows_write_to_pm: true, locale: null })
    await addReports(u.id, 3)
    expect(await maybeAutoPauseForReports(u.id)).toBe(true)
    expect(notifyPaused).toHaveBeenCalledWith(100, null)
  })

  it('does nothing below the threshold, and ignores resolved reports', async () => {
    const u = await createUser()
    await addReports(u.id, 2)
    await addReports(u.id, 3, { status: 'dismissed' })
    expect(await maybeAutoPauseForReports(u.id)).toBe(false)
    expect(await pausedAt(u.id)).toBeNull()
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('does nothing when the threshold is 0 (disabled)', async () => {
    const u = await createUser()
    await setThreshold(0)
    await addReports(u.id, 5)
    expect(await maybeAutoPauseForReports(u.id)).toBe(false)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('is a no-op when the user is already paused/banned (update matched no row)', async () => {
    const paused = await createUser({ paused_at: '2026-10-01T00:00:00Z' })
    const banned = await createUser({ banned_at: '2026-10-01T00:00:00Z' })
    await createPhoto(banned.id, 0)
    await addReports(paused.id, 5)
    await addReports(banned.id, 5)
    expect(await maybeAutoPauseForReports(paused.id)).toBe(false)
    expect(await maybeAutoPauseForReports(banned.id)).toBe(false)
    expect(await pausedAt(paused.id)).toBe('2026-10-01T00:00:00.000Z')
    expect(await pausedAt(banned.id)).toBeNull()
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('pauses but skips the DM when the user blocked bot PMs', async () => {
    const u = await createUser({ telegram_id: 100, allows_write_to_pm: false })
    await addReports(u.id, 3)
    expect(await maybeAutoPauseForReports(u.id)).toBe(true)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('never throws (returns false on a DB error)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    await addReports(u.id, 3)
    await withMissingTable('reports', async () => expect(await maybeAutoPauseForReports(u.id)).toBe(false))
    // Malformed id → 22P02 thrown by Postgres → still false.
    expect(await maybeAutoPauseForReports('reported-1')).toBe(false)
    errorSpy.mockRestore()
  })
})

describe('pauseForPhotoReview', () => {
  it('returns false (no throw) when the pause write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await createUser()
    await withFailingWrites('users', 'update', async () => expect(await pauseForPhotoReview(u.id)).toBe(false))
    expect(await pausedAt(u.id)).toBeNull()
    errorSpy.mockRestore()
  })

  it('only one of two concurrent callers transitions the user', async () => {
    const u = await createUser({ telegram_id: 100 })
    const results = await Promise.all([pauseForPhotoReview(u.id), pauseForPhotoReview(u.id)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(notifyPaused).toHaveBeenCalledTimes(1)
  })
})

describe('maybeWarnFakePhoto', () => {
  async function warnSetup({ threshold, fakeCount, otherPending = 0, user = {} }: {
    threshold: number; fakeCount: number; otherPending?: number; user?: Record<string, unknown>
  }) {
    await setThreshold(threshold)
    const u = await createUser({
      telegram_id: 100, allows_write_to_pm: true, locale: 'en', gender: 'woman', looking_for: 'men', ...user,
    })
    await addReports(u.id, fakeCount, { reason: 'fake' })
    await addReports(u.id, otherPending, { reason: 'spam' })
    return u
  }

  it('warns a woman exactly at half the threshold', async () => {
    const u = await warnSetup({ threshold: 4, fakeCount: 2 })
    expect(await maybeWarnFakePhoto(u.id)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'en', 'woman')
  })

  it('warns a man with his own copy', async () => {
    const u = await warnSetup({ threshold: 4, fakeCount: 2, user: { gender: 'man', looking_for: 'women', locale: 'fa' } })
    expect(await maybeWarnFakePhoto(u.id)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'fa', 'man')
  })

  it('uses the gentler message for anyone who is not a man', async () => {
    const u = await warnSetup({ threshold: 3, fakeCount: 2, user: { gender: 'nonbinary' } })
    expect(await maybeWarnFakePhoto(u.id)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'en', 'nonbinary')
  })

  it('does nothing below half, past half, or when the threshold cannot be halved', async () => {
    for (const [threshold, fakeCount] of [[4, 1], [4, 3], [1, 1], [0, 5]]) {
      await resetDb()
      const u = await warnSetup({ threshold, fakeCount })
      expect(await maybeWarnFakePhoto(u.id), `${threshold}/${fakeCount}`).toBe(false)
    }
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('counts only pending fake reports toward the warning', async () => {
    const u = await warnSetup({ threshold: 4, fakeCount: 1 })
    await addReports(u.id, 1, { reason: 'fake', status: 'dismissed' })
    expect(await maybeWarnFakePhoto(u.id)).toBe(false)
  })

  it('stays quiet when this report also crosses the pause line', async () => {
    const u = await warnSetup({ threshold: 4, fakeCount: 2, otherPending: 2 })
    expect(await maybeWarnFakePhoto(u.id)).toBe(false)
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('skips paused, banned, and users who blocked bot PMs', async () => {
    for (const user of [
      { paused_at: '2026-01-01T00:00:00Z' },
      { banned_at: '2026-01-01T00:00:00Z' },
      { allows_write_to_pm: false },
    ]) {
      await resetDb()
      const u = await warnSetup({ threshold: 4, fakeCount: 2, user })
      expect(await maybeWarnFakePhoto(u.id)).toBe(false)
    }
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('never throws (returns false on a DB error)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u = await warnSetup({ threshold: 4, fakeCount: 2 })
    await withMissingTable('reports', async () => expect(await maybeWarnFakePhoto(u.id)).toBe(false))
    expect(await maybeWarnFakePhoto('reported-1')).toBe(false)
    errorSpy.mockRestore()
  })
})
