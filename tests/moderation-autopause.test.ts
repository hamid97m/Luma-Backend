import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn() }))

import { db } from '../src/db.js'
import { notifyPaused } from '../src/bot.js'
import { maybeAutoPauseForReports } from '../src/moderation/autoPause.js'
import { chainable } from './admin-helpers.js'

const REPORTED = 'reported-1'

function mockDb({ threshold, pendingCount, updateData }: {
  threshold: number
  pendingCount: number
  updateData: unknown
}) {
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'moderation_config') return chainable({ data: { photo_report_threshold: threshold }, error: null })
    if (table === 'reports') return chainable({ count: pendingCount, error: null })
    if (table === 'users') return chainable({ data: updateData, error: null })
    return chainable({ data: null, error: null })
  })
}

describe('maybeAutoPauseForReports', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pauses and notifies once the pending count reaches the threshold', async () => {
    mockDb({ threshold: 3, pendingCount: 3, updateData: { telegram_id: 100, allows_write_to_pm: true } })
    const paused = await maybeAutoPauseForReports(REPORTED)
    expect(paused).toBe(true)
    expect(notifyPaused).toHaveBeenCalledWith(100)
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
