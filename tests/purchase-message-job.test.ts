import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
  forwardBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { runPurchaseMessageJob, maybeSendPurchaseMessageForUser } from '../src/jobs/purchaseMessage.js'
import type { PurchaseMessageConfig as Cfg } from '../src/jobs/purchaseMessageConfig.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { createTx, ago } from './helpers/premium.js'

const MIN = 60 * 1000

const textCfg: Cfg = {
  enabled: true, kind: 'text', message: 'come back!', button: null,
  sourceChatId: null, sourceMessageId: null, activeSince: '2026-01-01T00:00:00.000Z', translations: {},
}

/** An Iranian user (override anything) with an abandoned checkout `ageMs` old. */
async function abandoner(overrides: Record<string, unknown> = {}, ageMs = 10 * MIN) {
  const u = await createUser({ geo_country: 'IR', ...overrides })
  await createTx(u.id, { created_at: ago(ageMs) })
  return u
}

const sends = () => sql`select user_id, status from purchase_message_sends order by sent_at`

describe('runPurchaseMessageJob (backstop sweep)', () => {
  beforeEach(async () => { await resetDb() })

  it('messages a fresh abandoner once and records the send', async () => {
    const u1 = await abandoner({ telegram_id: 111 })
    const u2 = await abandoner() // also completed a purchase
    await createTx(u2.id, { status: 'paid' })
    const u3 = await abandoner() // already messaged
    await sql`insert into purchase_message_sends (user_id) values (${u3.id})`

    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })

    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(111, 'come back!', undefined)
    expect(await sends()).toEqual([{ user_id: u3.id, status: 'sent' }, { user_id: u1.id, status: 'sent' }])

    // A second run messages nobody (the user is never messaged twice).
    sendText.mockClear()
    expect(await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })).toEqual({ eligible: 0, sent: 0, blocked: 0, failed: 0 })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('no-ops when disabled / empty / no candidates', async () => {
    await abandoner({ telegram_id: 1 })
    const sendA = vi.fn()
    expect((await runPurchaseMessageJob({ getConfig: async () => ({ ...textCfg, enabled: false }), sendText: sendA })).sent).toBe(0)
    const sendB = vi.fn()
    expect((await runPurchaseMessageJob({ getConfig: async () => ({ ...textCfg, message: '  ' }), sendText: sendB })).sent).toBe(0)
    await resetDb()
    const sendC = vi.fn()
    expect((await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText: sendC })).eligible).toBe(0)
    expect(sendA).not.toHaveBeenCalled(); expect(sendB).not.toHaveBeenCalled(); expect(sendC).not.toHaveBeenCalled()
    expect(await sends()).toEqual([])
  })

  it('ignores attempts inside the grace window or before active_since', async () => {
    await abandoner({}, 2 * MIN)                                 // too fresh — the per-payment timer owns it
    const old = await createUser({ geo_country: 'IR' })
    await createTx(old.id, { created_at: '2025-12-01T00:00:00.000Z' }) // before the feature was switched on
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })
    expect(stats.eligible).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('skips seed, banned, deleted, PM-disallowed and non-positive telegram ids; allows null allows_write_to_pm', async () => {
    await abandoner({ is_seed: true })
    await abandoner({ banned_at: new Date().toISOString() })
    await abandoner({ deleted_at: new Date().toISOString() })
    await abandoner({ allows_write_to_pm: false })
    await abandoner({ telegram_id: -5 })
    const ok = await abandoner({ telegram_id: 4242, allows_write_to_pm: null })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(4242, 'come back!', undefined)
    expect((await sends()).map((r) => r.user_id)).toEqual([ok.id])
  })

  it('records blocked (403): claim then flip status to blocked, not counted sent', async () => {
    const u = await abandoner({ telegram_id: 333 })
    const sendText = vi.fn(() => Promise.reject(Object.assign(new Error('Forbidden'), { error_code: 403 })))
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 1, failed: 0 })
    expect(await sends()).toEqual([{ user_id: u.id, status: 'blocked' }])
  })

  it('releases the claim on a transient failure so it retries next run', async () => {
    const u = await abandoner({ telegram_id: 444 })
    const sendText = vi.fn(() => Promise.reject(new Error('network')))
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText, log: { warn: vi.fn() } })
    expect(stats).toEqual({ eligible: 1, sent: 0, blocked: 0, failed: 1 })
    expect(await sends()).toEqual([])

    const retry = vi.fn(() => Promise.resolve())
    expect((await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText: retry })).sent).toBe(1)
    expect(await sends()).toEqual([{ user_id: u.id, status: 'sent' }])
  })

  it('skips a user whose claim is lost to a race (claimed between the scan and the send)', async () => {
    const a = await abandoner({ telegram_id: 555 })
    const b = await abandoner({ telegram_id: 556 })
    const sendText = vi.fn((_tg: number) => Promise.resolve())
    // batchSize 1 → the pause between the two sends is where another sender
    // (the per-payment timer) claims whichever user hasn't been sent yet.
    const sleep = async () => {
      const sentTg = sendText.mock.calls[0][0]
      const other = sentTg === 555 ? b : a
      await sql`insert into purchase_message_sends (user_id) values (${other.id})`
    }
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText, batchSize: 1, sleep })
    expect(stats).toEqual({ eligible: 2, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledTimes(1)
    expect((await sends()).length).toBe(2) // both claimed, each exactly once
  })

  it('the per-payment timer and the backstop racing for one user send exactly once', async () => {
    const u = await abandoner({ telegram_id: 556 })
    const sendText = vi.fn(() => Promise.resolve())
    const [a, b] = await Promise.all([
      runPurchaseMessageJob({ getConfig: async () => textCfg, sendText }),
      maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText }),
    ])
    expect(a.sent + b.sent).toBe(1)
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(await sends()).toEqual([{ user_id: u.id, status: 'sent' }])
  })

  it('backstop messages only Iranian abandoners', async () => {
    const ir = await abandoner({ telegram_id: 111, geo_country: 'IR' })
    await abandoner({ telegram_id: 222, geo_country: 'AE' })
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith(111, 'come back!', undefined)
    expect(await sends()).toEqual([{ user_id: ir.id, status: 'sent' }])
  })

  it('sends in batches with a pause between them, capped per run', async () => {
    for (let i = 0; i < 5; i++) await abandoner()
    const sendText = vi.fn(() => Promise.resolve())
    const sleep = vi.fn(async () => {})
    const stats = await runPurchaseMessageJob({ getConfig: async () => textCfg, sendText, cap: 4, batchSize: 2, pauseMs: 7, sleep })
    expect(stats).toEqual({ eligible: 4, sent: 4, blocked: 0, failed: 0 })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7)
  })
})

describe('maybeSendPurchaseMessageForUser (per-payment path)', () => {
  beforeEach(async () => { await resetDb() })

  it('messages an eligible unpaid user once', async () => {
    const u = await abandoner({ telegram_id: 777 }, 0)
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 1, sent: 1, blocked: 0, failed: 0 })
    expect(sendText).toHaveBeenCalledWith(777, 'come back!', undefined)
    expect(await sends()).toEqual([{ user_id: u.id, status: 'sent' }])

    // never twice
    const again = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(again.sent).toBe(0)
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the user already completed a purchase', async () => {
    const u = await abandoner()
    await createTx(u.id, { status: 'paid' })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does nothing when the user was already messaged', async () => {
    const u = await abandoner()
    await sql`insert into purchase_message_sends (user_id) values (${u.id})`
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does nothing when the payment already succeeded (no pending attempt)', async () => {
    const u = await createUser({ geo_country: 'IR' })
    await createTx(u.id, { status: 'canceled' })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats.eligible).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('ignores a pending attempt from before active_since', async () => {
    const u = await abandoner({}, 0)
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, {
      getConfig: async () => ({ ...textCfg, activeSince: new Date(Date.now() + MIN).toISOString() }), sendText,
    })
    expect(stats.eligible).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('sends the translated text and button title for a non-Persian recipient', async () => {
    const u = await abandoner({ telegram_id: 999, locale: 'en' })
    const sendText = vi.fn(() => Promise.resolve())
    const cfg: Cfg = {
      ...textCfg, button: { kind: 'screen', screen: 'plans', title: 'طرح‌ها' } as any,
      translations: { en: { message: 'Come back!', buttonTitle: 'Plans' } },
    }
    await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => cfg, sendText })
    expect(sendText).toHaveBeenCalledWith(999, 'Come back!', { kind: 'screen', screen: 'plans', title: 'Plans' })
  })

  it('does not message an abandoner outside Iran', async () => {
    const u = await abandoner({ telegram_id: 777, geo_country: 'AE' })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats).toEqual({ eligible: 0, sent: 0, blocked: 0, failed: 0 })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does not message an abandoner whose country is unresolved', async () => {
    const u = await abandoner({ telegram_id: 777, geo_country: null })
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => textCfg, sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('forwards when kind=forward', async () => {
    const u = await abandoner({ telegram_id: 888 })
    const forward = vi.fn(() => Promise.resolve())
    const cfg: Cfg = { ...textCfg, kind: 'forward', message: 'https://t.me/c/1/2', sourceChatId: '-1001', sourceMessageId: 2 }
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => cfg, forward })
    expect(forward).toHaveBeenCalledWith(888, '-1001', 2)
    expect(stats.sent).toBe(1)
  })

  it('no-ops when the config is disabled', async () => {
    const u = await abandoner()
    const sendText = vi.fn()
    const stats = await maybeSendPurchaseMessageForUser(u.id, { getConfig: async () => ({ ...textCfg, enabled: false }), sendText })
    expect(stats.sent).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('reads the real config row by default', async () => {
    const u = await abandoner({ telegram_id: 1234 }, 0)
    await sql`update purchase_message_config set enabled = true, message = 'from db', active_since = ${'2026-01-01T00:00:00.000Z'} where id = true`
    const sendText = vi.fn(() => Promise.resolve())
    const stats = await maybeSendPurchaseMessageForUser(u.id, { sendText })
    expect(stats.sent).toBe(1)
    expect(sendText).toHaveBeenCalledWith(1234, 'from db', undefined)
  })
})
