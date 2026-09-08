import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
  forwardBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { runPurchaseMessageJob } from '../src/jobs/purchaseMessage.js'
import type { PurchaseMessageConfig as Cfg } from '../src/jobs/purchaseMessageConfig.js'

// Builder stub: premium_transactions distinguishes the pending vs paid scan by
// the status filter; other tables return their fixed row sets. insert() is logged.
function buildDb(sets: {
  attempts?: any[]; paid?: any[]; sent?: any[]; users?: any[]; inserts: any[]
}) {
  return {
    from(table: string) {
      const state: { status: string | null } = { status: null }
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === 'status') state.status = val; return q },
        lte: () => q, gte: () => q, in: () => q, is: () => q, gt: () => q, or: () => q,
        order: () => q, limit: () => q,
        insert: (row: any) => { sets.inserts.push({ table, row }); return Promise.resolve({ error: null }) },
        then: (resolve: any, reject: any) => {
          let data: any[] = []
          if (table === 'premium_transactions') data = state.status === 'paid' ? (sets.paid ?? []) : (sets.attempts ?? [])
          else if (table === 'purchase_message_sends') data = sets.sent ?? []
          else if (table === 'users') data = sets.users ?? []
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
}

const textCfg: Cfg = {
  enabled: true, kind: 'text', message: 'come back!', button: null,
  sourceChatId: null, sourceMessageId: null, activeSince: '2026-01-01T00:00:00.000Z',
}

describe('runPurchaseMessageJob', () => {
  it('messages a fresh abandoner once and records the send', async () => {
    const inserts: any[] = []
    const db = buildDb({
      attempts: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
      paid: [{ user_id: 'u2' }],          // u2 completed → excluded
      sent: [{ user_id: 'u3' }],          // u3 already messaged → excluded
      users: [{ id: 'u1', telegram_id: 111 }],
      inserts,
    })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(111, 'come back!', undefined)
    expect(inserts).toEqual([{ table: 'purchase_message_sends', row: { user_id: 'u1', status: 'sent' } }])
  })

  it('no-ops when the config is disabled', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 1 }], inserts })
    const sendText = vi.fn()
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => ({ ...textCfg, enabled: false }), sendText })
    expect(stats).toEqual({ eligible: 0, sent: 0, blocked: 0, failed: 0 })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('no-ops when enabled but the message is empty', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 1 }], inserts })
    const sendText = vi.fn()
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => ({ ...textCfg, message: '   ' }), sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('forwards when kind=forward', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 222 }], inserts })
    const forward = vi.fn(() => Promise.resolve())
    const cfg: Cfg = { ...textCfg, kind: 'forward', message: 'https://t.me/c/1/2', sourceChatId: '-1001', sourceMessageId: 2 }
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => cfg, forward })
    expect(forward).toHaveBeenCalledWith(222, '-1001', 2)
    expect(stats.sent).toBe(1)
  })

  it('records blocked (403) and does not count it as sent', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 333 }], inserts })
    const sendText = vi.fn(() => Promise.reject(Object.assign(new Error('Forbidden'), { error_code: 403 })))
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 1, failed: 0 })
    expect(inserts).toEqual([{ table: 'purchase_message_sends', row: { user_id: 'u1', status: 'blocked' } }])
  })

  it('does NOT record a transient failure (so it retries next run)', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 444 }], inserts })
    const sendText = vi.fn(() => Promise.reject(new Error('network')))
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 0, failed: 1 })
    expect(inserts).toEqual([])
  })

  it('no-ops when there are no candidate attempts', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [], inserts })
    const sendText = vi.fn()
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats.eligible).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })
})
