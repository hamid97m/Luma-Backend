import { describe, it, expect, vi } from 'vitest'
import { runBroadcast, botSendAdapter, type SendOutcome } from '../src/messaging/broadcast.js'
import type { BroadcastTarget } from '../src/messaging/audience.js'

const noSleep = async () => {}
function targets(n: number): BroadcastTarget[] {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, telegram_id: 1000 + i }))
}
function baseOpts(overrides: Partial<Parameters<typeof runBroadcast>[1]> = {}) {
  return {
    send: vi.fn().mockResolvedValue('ok' as SendOutcome),
    onOptOut: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn().mockResolvedValue(undefined),
    sleep: noSleep,
    batchSize: 2,
    pauseMs: 0,
    ...overrides,
  }
}

describe('runBroadcast', () => {
  it('counts fail outcomes, treats a throwing send as fail, and calls onOptOut for optout', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce('fail')
      .mockResolvedValueOnce('optout')
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('ok')
    const opts = baseOpts({ send })
    const res = await runBroadcast(targets(4), opts)
    expect(opts.onOptOut).toHaveBeenCalledTimes(1)
    expect(opts.onOptOut).toHaveBeenCalledWith('u1')
    expect(res).toEqual({ sent: 1, failed: 3 })
  })

  it('sends to every target and reports the full count', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined)
    const opts = baseOpts({ send: botSendAdapter(deliver, noSleep) })
    const res = await runBroadcast(targets(5), opts)
    expect(deliver).toHaveBeenCalledTimes(5)
    expect(deliver).toHaveBeenCalledWith(1000)
    expect(res).toEqual({ sent: 5, failed: 0 })
  })

  it('counts a failed send and continues', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))   // 2nd target
      .mockResolvedValue(undefined)
    const opts = baseOpts({ send: botSendAdapter(deliver, noSleep) })
    const res = await runBroadcast(targets(3), opts)
    expect(res).toEqual({ sent: 2, failed: 1 })
  })

  it('flips opt-out when a send fails with Telegram 403 (blocked)', async () => {
    const blocked = Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 })
    const deliver = vi.fn().mockRejectedValueOnce(blocked).mockResolvedValue(undefined)
    const opts = baseOpts({ send: botSendAdapter(deliver, noSleep) })
    const res = await runBroadcast(targets(2), opts)
    expect(opts.onOptOut).toHaveBeenCalledWith('u0')
    expect(res).toEqual({ sent: 1, failed: 1 })
  })

  it('retries once on a 429 then counts success', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: 1 } })
    const deliver = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const opts = baseOpts({ send: botSendAdapter(deliver, sleep) })
    const res = await runBroadcast(targets(1), opts)
    expect(deliver).toHaveBeenCalledTimes(2) // first (429) + retry (ok)
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(res).toEqual({ sent: 1, failed: 0 })
  })

  it('reports progress after each batch', async () => {
    const opts = baseOpts({ batchSize: 2 })
    await runBroadcast(targets(5), opts) // batches: 2,2,1 => 3 progress calls
    expect(opts.onProgress).toHaveBeenCalledTimes(3)
    expect(opts.onProgress).toHaveBeenLastCalledWith({ sent: 5, failed: 0 })
  })
})
