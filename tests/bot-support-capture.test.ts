import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { createHash } from 'crypto'
import { Api, Bot } from 'grammy'

// A real BOT_TOKEN must exist before importing bot.ts derives the path/secret.
process.env.BOT_TOKEN = 'test-token'
process.env.WEB_URL = 'https://app.test'

// Offline bot: init() just installs botInfo; replies are captured, not sent.
vi.spyOn(Bot.prototype, 'init').mockImplementation(async function (this: Bot) {
  this.botInfo = {
    id: 1, is_bot: true, first_name: 'Luma', username: 'luma_bot', can_join_groups: false,
    can_read_all_group_messages: false, supports_inline_queries: false,
  } as any
})
const sendMessage = vi.spyOn(Api.prototype, 'sendMessage').mockResolvedValue({} as any)

import { mountWebhook, webhookPath } from '../src/bot.js'
import { tFor } from '../src/i18n/index.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'

const SECRET = createHash('sha256').update('test-token:secret').digest('hex')

let updateId = 1
function message(fromId: number, text: string, language_code = 'fa') {
  const isCommand = text.startsWith('/')
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U', language_code },
      text,
      ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
    },
  }
}

describe('bot support capture (real DB)', () => {
  let app: Awaited<ReturnType<typeof Fastify>>
  const post = (update: unknown) => app.inject({
    method: 'POST', url: webhookPath(), headers: { 'x-telegram-bot-api-secret-token': SECRET }, payload: update as any,
  })
  const lastReply = () => sendMessage.mock.calls.at(-1)?.[1]

  beforeAll(async () => {
    app = Fastify()
    mountWebhook(app)
    await app.ready()
  })
  beforeEach(async () => {
    await resetDb()
    sendMessage.mockClear()
  })

  it('/support stamps awaiting_support_since and replies in the saved locale', async () => {
    const u = await createUser({ locale: 'en' })
    expect((await post(message(u.telegram_id, '/support'))).statusCode).toBe(200)
    const [row] = await sql`select awaiting_support_since from users where id = ${u.id}`
    expect(row.awaiting_support_since).not.toBeNull()
    expect(lastReply()).toBe(tFor('en').support.prompt)
  })

  it('captures the next plain message as a ticket and clears the flag', async () => {
    const u = await createUser({ locale: 'en', awaiting_support_since: new Date().toISOString() })
    await post(message(u.telegram_id, 'my payment failed'))
    const [row] = await sql`select awaiting_support_since from users where id = ${u.id}`
    expect(row.awaiting_support_since).toBeNull()
    const msgs = await sql`select m.body, t.user_id from support_messages m join support_tickets t on t.id = m.ticket_id`
    expect(msgs).toEqual([{ body: 'my payment failed', user_id: u.id }])
    expect(lastReply()).toBe(tFor('en').support.ticketSaved)
  })

  it('replies tooManyOpen when the user is at the open-ticket cap', async () => {
    const u = await createUser({ locale: 'en', awaiting_support_since: new Date().toISOString() })
    for (let i = 0; i < 5; i++) await insertRow('support_tickets', { user_id: u.id })
    await post(message(u.telegram_id, 'again'))
    expect(lastReply()).toBe(tFor('en').support.tooManyOpen)
  })

  it('does not capture without a pending prompt — falls through to the start reply', async () => {
    const u = await createUser({ locale: 'en' })
    await post(message(u.telegram_id, 'hello'))
    expect(await sql`select id from support_tickets`).toHaveLength(0)
    expect(lastReply()).toBe(tFor('en').bot.start)
  })

  it('/start clears a pending prompt', async () => {
    const u = await createUser({ awaiting_support_since: new Date().toISOString() })
    await post(message(u.telegram_id, '/start'))
    const [row] = await sql`select awaiting_support_since from users where id = ${u.id}`
    expect(row.awaiting_support_since).toBeNull()
  })

  it('an unknown Telegram user gets the start reply in their client language', async () => {
    await post(message(999_999_999, 'hi', 'en'))
    expect(lastReply()).toBe(tFor('en').bot.start)
    expect(await sql`select id from support_tickets`).toHaveLength(0)
  })
})
