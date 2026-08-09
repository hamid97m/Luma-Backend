import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify from 'fastify'
import { Bot } from 'grammy'

// bot.js pulls in db.js (which constructs a Supabase client at import time) and
// the service modules — none of which this test exercises. Mock them out.
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

// A real BOT_TOKEN must exist before importing bot.ts derives the path/secret.
process.env.BOT_TOKEN = 'test-token'

// grammy's webhookCallback calls bot.init() (a getMe network request) on the
// first update, before the secret-token check. Stub it so the guard runs offline.
vi.spyOn(Bot.prototype, 'init').mockResolvedValue(undefined)

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
