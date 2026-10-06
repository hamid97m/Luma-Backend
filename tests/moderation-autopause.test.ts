import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(), notifyFakePhotoWarning: vi.fn() }))

import { db } from '../src/db.js'
import { notifyFakePhotoWarning, notifyPaused } from '../src/bot.js'
import { maybeAutoPauseForReports, maybeWarnFakePhoto } from '../src/moderation/autoPause.js'
import { chainable } from './admin-helpers.js'

const REPORTED = 'reported-1'

function mockDb({ threshold, pendingCount, updateData, photos }: {
  threshold: number
  pendingCount: number
  updateData: unknown
  photos?: Array<{ id: string }>
}) {
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'moderation_config') return chainable({ data: { photo_report_threshold: threshold }, error: null })
    if (table === 'reports') return chainable({ count: pendingCount, error: null })
    if (table === 'users') return chainable({ data: updateData, error: null })
    if (table === 'user_photos') return chainable({ data: photos ?? null, error: null })
    return chainable({ data: null, error: null })
  })
  const remove = vi.fn().mockResolvedValue({ error: null })
  vi.mocked(db.storage.from).mockImplementation(() => ({ remove } as any))
  return { storageRemove: remove }
}

describe('maybeAutoPauseForReports', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pauses and notifies (in the user\'s language) once the pending count reaches the threshold', async () => {
    const { storageRemove } = mockDb({
      threshold: 3,
      pendingCount: 3,
      updateData: { telegram_id: 100, allows_write_to_pm: true, locale: 'ar' },
      photos: [{ id: 'photo-1' }, { id: 'photo-2' }],
    })
    const paused = await maybeAutoPauseForReports(REPORTED)
    expect(paused).toBe(true)
    expect(notifyPaused).toHaveBeenCalledWith(100, 'ar')
    expect(db.storage.from).toHaveBeenCalledWith('profile-photos')
    expect(storageRemove).toHaveBeenCalledWith([`${REPORTED}/photo-1`, `${REPORTED}/photo-2`])
  })

  it('passes a null locale when the user has not picked a language yet', async () => {
    mockDb({ threshold: 3, pendingCount: 3, updateData: { telegram_id: 100, allows_write_to_pm: true, locale: null } })
    expect(await maybeAutoPauseForReports(REPORTED)).toBe(true)
    expect(notifyPaused).toHaveBeenCalledWith(100, null)
  })

  it('does nothing below the threshold', async () => {
    mockDb({ threshold: 3, pendingCount: 2, updateData: null })
    const paused = await maybeAutoPauseForReports(REPORTED)
    expect(paused).toBe(false)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('does nothing when the threshold is 0 (disabled)', async () => {
    mockDb({ threshold: 0, pendingCount: 99, updateData: null })
    expect(await maybeAutoPauseForReports(REPORTED)).toBe(false)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('is a no-op when the user is already paused/banned (update matched no row)', async () => {
    mockDb({ threshold: 3, pendingCount: 5, updateData: null })
    const paused = await maybeAutoPauseForReports(REPORTED)
    expect(paused).toBe(false)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('pauses but skips the DM when the user blocked bot PMs', async () => {
    mockDb({ threshold: 3, pendingCount: 3, updateData: { telegram_id: 100, allows_write_to_pm: false } })
    expect(await maybeAutoPauseForReports(REPORTED)).toBe(true)
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('never throws (returns false on a DB error)', async () => {
    vi.mocked(db.from).mockImplementation(() => { throw new Error('boom') })
    expect(await maybeAutoPauseForReports(REPORTED)).toBe(false)
  })
})

function mockWarnDb({
  threshold,
  fakeCount,
  pendingCount,
  user,
}: {
  threshold: number
  fakeCount: number
  pendingCount?: number
  user: unknown
}) {
  let reportQueries = 0
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'moderation_config') return chainable({ data: { photo_report_threshold: threshold }, error: null })
    if (table === 'reports') {
      reportQueries += 1
      const count = reportQueries === 1 ? fakeCount : (pendingCount ?? fakeCount)
      return chainable({ count, error: null })
    }
    if (table === 'users') return chainable({ data: user, error: null })
    return chainable({ data: null, error: null })
  })
}

const ACTIVE = {
  telegram_id: 100,
  allows_write_to_pm: true,
  locale: 'en',
  gender: 'woman',
  paused_at: null,
  banned_at: null,
}

describe('maybeWarnFakePhoto', () => {
  beforeEach(() => vi.clearAllMocks())

  it('warns a woman exactly at half the threshold', async () => {
    mockWarnDb({ threshold: 4, fakeCount: 2, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'en', 'woman')
  })

  it('warns a man with his own copy', async () => {
    mockWarnDb({ threshold: 4, fakeCount: 2, user: { ...ACTIVE, gender: 'man', locale: 'fa' } })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'fa', 'man')
  })

  it('uses the gentler message for anyone who is not a man', async () => {
    mockWarnDb({ threshold: 3, fakeCount: 2, user: { ...ACTIVE, gender: 'nonbinary' } })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(true)
    expect(notifyFakePhotoWarning).toHaveBeenCalledWith(100, 'en', 'nonbinary')
  })

  it('does nothing below half, past half, or when the threshold cannot be halved', async () => {
    mockWarnDb({ threshold: 4, fakeCount: 1, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)

    mockWarnDb({ threshold: 4, fakeCount: 3, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)

    mockWarnDb({ threshold: 1, fakeCount: 1, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)

    mockWarnDb({ threshold: 0, fakeCount: 5, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('stays quiet when this report also crosses the pause line', async () => {
    mockWarnDb({ threshold: 4, fakeCount: 2, pendingCount: 4, user: ACTIVE })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('skips paused, banned, and users who blocked bot PMs', async () => {
    mockWarnDb({ threshold: 4, fakeCount: 2, user: { ...ACTIVE, paused_at: '2026-01-01' } })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)

    mockWarnDb({ threshold: 4, fakeCount: 2, user: { ...ACTIVE, banned_at: '2026-01-01' } })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)

    mockWarnDb({ threshold: 4, fakeCount: 2, user: { ...ACTIVE, allows_write_to_pm: false } })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)
    expect(notifyFakePhotoWarning).not.toHaveBeenCalled()
  })

  it('never throws (returns false on a DB error)', async () => {
    vi.mocked(db.from).mockImplementation(() => { throw new Error('boom') })
    expect(await maybeWarnFakePhoto(REPORTED)).toBe(false)
  })
})
