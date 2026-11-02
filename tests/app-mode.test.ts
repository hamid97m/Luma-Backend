import { describe, it, expect, vi, afterEach } from 'vitest'
import { isStandby, standbyBotGuard } from '../src/appMode.js'

describe('APP_MODE', () => {
  afterEach(() => { delete process.env.APP_MODE })

  it('is standby only when APP_MODE=standby', () => {
    expect(isStandby()).toBe(false)
    process.env.APP_MODE = 'live'
    expect(isStandby()).toBe(false)
    process.env.APP_MODE = 'standby'
    expect(isStandby()).toBe(true)
  })
})

describe('standbyBotGuard', () => {
  it.each(['sendMessage', 'sendPhoto', 'forwardMessage', 'sendGift', 'refundStarPayment', 'setWebhook', 'setMyDescription', 'deleteMessage'])(
    'blocks %s without calling Telegram', async (method) => {
      const prev = vi.fn()
      const res = await standbyBotGuard(prev as never, method as never, {} as never)
      expect(prev).not.toHaveBeenCalled()
      expect(res).toMatchObject({ ok: false, error_code: 503 })
    })

  it.each(['getMe', 'getFile', 'getUserProfilePhotos', 'createInvoiceLink'])(
    'passes %s through', async (method) => {
      const prev = vi.fn(async () => ({ ok: true, result: 'x' }))
      const res = await standbyBotGuard(prev as never, method as never, { a: 1 } as never)
      expect(prev).toHaveBeenCalledWith(method, { a: 1 }, undefined)
      expect(res).toEqual({ ok: true, result: 'x' })
    })
})
