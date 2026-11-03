import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify from 'fastify'
import { Api, Bot, GrammyError } from 'grammy'
import { createHash } from 'crypto'

// A real BOT_TOKEN must exist before importing bot.ts derives the path/secret.
process.env.BOT_TOKEN = 'test-token'

// grammy's webhookCallback calls bot.init() (a getMe network request) on the
// first update, before the secret-token check. Stub it so the guard runs offline
// (setting a fake botInfo so updates past the guard can be handled).
vi.spyOn(Bot.prototype, 'init').mockImplementation(async function (this: Bot) {
  this.botInfo = { id: 1, is_bot: true, first_name: 'Luma', username: 'luma_test_bot' } as Bot['botInfo']
})

import { mountWebhook, webhookPath } from '../src/bot.js'
import { WEBHOOK_ROUTE_PREFIX } from '../src/webhookRoute.js'

describe('webhook path/secret derivation', () => {
  it('lives under the exempt prefix', () => {
    expect(webhookPath().startsWith(`${WEBHOOK_ROUTE_PREFIX}/`)).toBe(true)
  })

  it('is deterministic for a given token', () => {
    expect(webhookPath()).toBe(webhookPath())
  })
})

describe('webhook route secret-token guard', () => {
  let app: Awaited<ReturnType<typeof Fastify>>

  beforeAll(async () => {
    app = Fastify()
    mountWebhook(app)
    await app.ready()
  })

  it('rejects a POST with no secret-token header (before touching the bot)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: webhookPath(),
      payload: { update_id: 1 },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a POST with the wrong secret-token header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: webhookPath(),
      headers: { 'x-telegram-bot-api-secret-token': 'nope' },
      payload: { update_id: 1 },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('webhook route handler failures', () => {
  let app: Awaited<ReturnType<typeof Fastify>>
  const secret = createHash('sha256').update('test-token:secret').digest('hex')

  beforeAll(async () => {
    app = Fastify()
    mountWebhook(app)
    await app.ready()
  })

  it('acknowledges with 200 when a handler throws, so Telegram stops redelivering', async () => {
    // The user blocked the bot: the /start-style reply fails with a 403.
    const send = vi.spyOn(Api.prototype, 'sendMessage').mockRejectedValue(
      new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'sendMessage', {}),
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.inject({
      method: 'POST',
      url: webhookPath(),
      headers: { 'x-telegram-bot-api-secret-token': secret },
      // No `from`: skips the DB lookups and falls through to sendStart.
      payload: { update_id: 42, message: { message_id: 1, date: 0, chat: { id: 777, type: 'private' }, text: 'hi' } },
    })
    expect(send).toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(log.mock.calls.some((c) => String(c[0]).includes('update 42') && String(c[0]).includes('chat 777'))).toBe(true)
    send.mockRestore()
    log.mockRestore()
  })
})
