import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
  forwardBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { runPurchaseMessageJob, maybeSendPurchaseMessageForUser } from '../src/jobs/purchaseMessage.js'
import type { PurchaseMessageConfig as Cfg } from '../src/jobs/purchaseMessageConfig.js'

// Builder stub. SELECTs resolve via `then`; premium_transactions distinguishes
// the pending vs paid scan by the status filter. insert/update/delete are logged
// and return their own promises so claim/finalize can be asserted.
function buildDb(sets: {
  attempts?: any[]; paid?: any[]; pending?: any[]; sent?: any[]; users?: any[]
  inserts: any[]; updates?: any[]; deletes?: any[]; insertError?: any
}) {
  return {
    from(table: string) {
      const state: { status: string | null } = { status: null }
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === 'status') state.status = val; return q },
        lte: () => q, gte: () => q, in: () => q, is: () => q, gt: () => q, or: () => q,
        order: () => q, limit: () => q,
        insert: (row: any) => { sets.inserts.push({ table, row }); return Promise.resolve({ error: sets.insertError ?? null }) },
        update: (patch: any) => { sets.updates?.push({ table, patch }); return { eq: () => Promise.resolve({ error: null }) } },
        delete: () => ({ eq: (col: string, val: any) => { sets.deletes?.push({ table, [col]: val }); return Promise.resolve({ error: null }) } }),
        then: (resolve: any, reject: any) => {
          let data: any[] = []
          if (table === 'premium_transactions') {
            data = state.status === 'paid' ? (sets.paid ?? [])
              : (sets.pending !== undefined ? sets.pending : (sets.attempts ?? []))
          } else if (table === 'purchase_message_sends') data = sets.sent ?? []
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

describe('runPurchaseMessageJob (backstop sweep)', () => {
  it('messages a fresh abandoner once and records the send', async () => {
    const inserts: any[] = []
    const db = buildDb({
      attempts: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
      paid: [{ user_id: 'u2' }], sent: [{ user_id: 'u3' }],
      users: [{ id: 'u1', telegram_id: 111 }], inserts,
    })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(111, 'come back!', undefined)
    expect(inserts).toEqual([{ table: 'purchase_message_sends', row: { user_id: 'u1', status: 'sent' } }])
  })

  it('no-ops when disabled / empty / no candidates', async () => {
    const sendA = vi.fn()
    expect((await runPurchaseMessageJob({ db: buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 1 }], inserts: [] }), getConfig: async () => ({ ...textCfg, enabled: false }), sendText: sendA })).sent).toBe(0)
    const sendB = vi.fn()
    expect((await runPurchaseMessageJob({ db: buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 1 }], inserts: [] }), getConfig: async () => ({ ...textCfg, message: '  ' }), sendText: sendB })).sent).toBe(0)
    const sendC = vi.fn()
    expect((await runPurchaseMessageJob({ db: buildDb({ attempts: [], inserts: [] }), getConfig: async () => textCfg, sendText: sendC })).eligible).toBe(0)
    expect(sendA).not.toHaveBeenCalled(); expect(sendB).not.toHaveBeenCalled(); expect(sendC).not.toHaveBeenCalled()
  })

  it('records blocked (403): claim then flip status to blocked, not counted sent', async () => {
    const inserts: any[] = [], updates: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 333 }], inserts, updates })
    const sendText = vi.fn(() => Promise.reject(Object.assign(new Error('Forbidden'), { error_code: 403 })))
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 1, failed: 0 })
    expect(inserts).toEqual([{ table: 'purchase_message_sends', row: { user_id: 'u1', status: 'sent' } }])
    expect(updates).toEqual([{ table: 'purchase_message_sends', patch: { status: 'blocked' } }])
  })

  it('releases the claim on a transient failure so it retries next run', async () => {
    const inserts: any[] = [], deletes: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 444 }], inserts, deletes })
    const sendText = vi.fn(() => Promise.reject(new Error('network')))
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 0, failed: 1 })
    expect(deletes).toEqual([{ table: 'purchase_message_sends', user_id: 'u1' }])
  })

  it('skips a user whose claim is lost to a race (insert conflict)', async () => {
    const inserts: any[] = []
    const db = buildDb({ attempts: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 555 }], inserts, insertError: { code: '23505' } })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 0, failed: 0 })
    expect(sendText).not.toHaveBeenCalled()
  })
})

describe('maybeSendPurchaseMessageForUser (per-payment path)', () => {
  it('messages an eligible unpaid user once', async () => {
    const inserts: any[] = []
    const db = buildDb({ paid: [], pending: [{ id: 'tx1' }], sent: [], users: [{ id: 'u1', telegram_id: 777 }], inserts })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(777, 'come back!', undefined)
    expect(inserts).toEqual([{ table: 'purchase_message_sends', row: { user_id: 'u1', status: 'sent' } }])
  })

  it('does nothing when the user already completed a purchase', async () => {
    const inserts: any[] = []
    const db = buildDb({ paid: [{ id: 'txp' }], pending: [{ id: 'tx1' }], sent: [], users: [{ id: 'u1', telegram_id: 1 }], inserts })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => textCfg, sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does nothing when the user was already messaged', async () => {
    const inserts: any[] = []
    const db = buildDb({ paid: [], pending: [{ id: 'tx1' }], sent: [{ user_id: 'u1' }], users: [{ id: 'u1', telegram_id: 1 }], inserts })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => textCfg, sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does nothing when the payment already succeeded (no pending attempt)', async () => {
    const inserts: any[] = []
    const db = buildDb({ paid: [], pending: [], sent: [], users: [{ id: 'u1', telegram_id: 1 }], inserts })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => textCfg, sendText })
    expect(stats.eligible).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('forwards when kind=forward', async () => {
    const inserts: any[] = []
    const db = buildDb({ paid: [], pending: [{ id: 'tx1' }], sent: [], users: [{ id: 'u1', telegram_id: 888 }], inserts })
    const forward = vi.fn(() => Promise.resolve())
    const cfg: Cfg = { ...textCfg, kind: 'forward', message: 'https://t.me/c/1/2', sourceChatId: '-1001', sourceMessageId: 2 }
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => cfg, forward })
    expect(forward).toHaveBeenCalledWith(888, '-1001', 2)
    expect(stats.sent).toBe(1)
  })

  it('no-ops when the config is disabled', async () => {
    const db = buildDb({ paid: [], pending: [{ id: 'tx1' }], sent: [], users: [{ id: 'u1', telegram_id: 1 }], inserts: [] })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser('u1', { db, getConfig: async () => ({ ...textCfg, enabled: false }), sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })
})
