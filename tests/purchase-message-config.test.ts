import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { updatePurchaseMessageConfig } from '../src/jobs/purchaseMessageConfig.js'

// Explicit stub (not the generic chainable) so we can distinguish the initial
// read from the update and capture exactly what columns get written.
function makeDb(current: any, captured: { updates?: any }) {
  return {
    from() {
      return {
        select() { return this },
        eq() { return this },
        single: async () => ({ data: current, error: null }),
        update(updates: any) {
          captured.updates = updates
          const row = { ...current, ...updates }
          return {
            eq() { return this },
            select() { return this },
            single: async () => ({ data: row, error: null }),
          }
        },
      }
    },
  }
}

const NOW = '2026-09-09T12:00:00.000Z'

describe('updatePurchaseMessageConfig', () => {
  it('stamps active_since when enabling (off → on)', async () => {
    const captured: { updates?: any } = {}
    const db = makeDb({ enabled: false, kind: 'text', active_since: null }, captured)
    const res = await updatePurchaseMessageConfig({ enabled: true }, db, NOW)
    expect(captured.updates.enabled).toBe(true)
    expect(captured.updates.active_since).toBe(NOW)
    expect(res?.activeSince).toBe(NOW)
  })

  it('does NOT move active_since when re-saving an already-enabled message', async () => {
    const captured: { updates?: any } = {}
    const db = makeDb({ enabled: true, kind: 'text', active_since: '2026-01-01T00:00:00.000Z' }, captured)
    await updatePurchaseMessageConfig({ enabled: true, message: 'hi' }, db, NOW)
    expect('active_since' in captured.updates).toBe(false)
    expect(captured.updates.message).toBe('hi')
  })

  it('does not stamp active_since when only editing content (enabled untouched)', async () => {
    const captured: { updates?: any } = {}
    const db = makeDb({ enabled: false, kind: 'text', active_since: null }, captured)
    await updatePurchaseMessageConfig({ message: 'draft' }, db, NOW)
    expect('active_since' in captured.updates).toBe(false)
  })

  it('maps forward fields to snake_case columns', async () => {
    const captured: { updates?: any } = {}
    const db = makeDb({ enabled: false, kind: 'text', active_since: null }, captured)
    await updatePurchaseMessageConfig(
      { kind: 'forward', message: 'https://t.me/c/1/2', sourceChatId: '-1001', sourceMessageId: 2 },
      db, NOW,
    )
    expect(captured.updates.kind).toBe('forward')
    expect(captured.updates.source_chat_id).toBe('-1001')
    expect(captured.updates.source_message_id).toBe(2)
  })
})
