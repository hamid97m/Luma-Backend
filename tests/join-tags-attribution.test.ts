import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
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
import { signIn } from '../src/accounts.js'
import { parseJoinTag } from '../src/joinTags/attribution.js'
import { tFor } from '../src/i18n/index.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { clearFailures, failOn, failReadsOf } from './helpers/bot-support.js'

const SECRET = createHash('sha256').update('test-token:secret').digest('hex')

let updateId = 1
function startUpdate(fromId: number, payload?: string) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U', language_code: 'en' },
      text: payload ? `/start ${payload}` : '/start',
      entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
    },
  }
}

const NEW_ID = 555_001

const startsFor = (telegramId: number) => sql`
  select tag, existing_user from join_tag_starts where telegram_id = ${telegramId} order by first_at`
const newUser = async (id = NEW_ID) => {
  const res = await signIn({ kind: 'telegram', tgUser: { id, first_name: 'New' } })
  expect(res.ok).toBe(true)
  const [row] = await sql`select id, join_tag, referred_by from users where telegram_id = ${id}`
  return row
}

describe('parseJoinTag', () => {
  it('accepts every character Telegram allows, up to 64 chars, in lowercase', () => {
    expect(parseJoinTag('insta_nov')).toBe('insta_nov')
    expect(parseJoinTag('A-b_9')).toBe('a-b_9')
    expect(parseJoinTag('ad_x')).toBe('ad_x')
    expect(parseJoinTag('x'.repeat(64))).toBe('x'.repeat(64))
  })

  it('groups case variants together', () => {
    expect(parseJoinTag('Insta')).toBe(parseJoinTag('insta'))
    expect(parseJoinTag('INSTA')).toBe('insta')
  })

  it('skips empty and reserved values, in any case', () => {
    for (const reserved of [null, undefined, '', 'support', 'SUPPORT', 'Support', 'none', 'NONE', 'None', 'ref_x', 'ref_', 'REF_x', 'Ref_abc']) {
      expect(parseJoinTag(reserved)).toBeNull()
    }
  })

  it('still accepts values that only resemble the reserved ones', () => {
    expect(parseJoinTag('support2')).toBe('support2')
    expect(parseJoinTag('referral')).toBe('referral')
  })

  it('rejects invalid characters and over-long values', () => {
    for (const bad of ['a b', 'a.b', 'a/b', 'اینستا', 'a!', 'x'.repeat(65)]) {
      expect(parseJoinTag(bad)).toBeNull()
    }
  })
})

describe('join tag attribution (real DB)', () => {
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
  afterEach(clearFailures)

  describe('/start', () => {
    it('records a tag for a person with no account, with no setup step', async () => {
      const res = await post(startUpdate(NEW_ID, 'insta_nov'))
      expect(res.statusCode).toBe(200)
      expect(await startsFor(NEW_ID)).toEqual([{ tag: 'insta_nov', existing_user: false }])
      expect(lastReply()).toBe(tFor('en').bot.start)
    })

    it('flags a person who already has an account', async () => {
      const u = await createUser()
      await post(startUpdate(u.telegram_id, 'insta'))
      expect(await startsFor(u.telegram_id)).toEqual([{ tag: 'insta', existing_user: true }])
    })

    it('stores the tag in lowercase, so case variants are one row', async () => {
      await post(startUpdate(NEW_ID, 'Insta'))
      await post(startUpdate(NEW_ID, 'INSTA'))
      await post(startUpdate(NEW_ID, 'insta'))
      expect(await startsFor(NEW_ID)).toEqual([{ tag: 'insta', existing_user: false }])
    })

    it('ignores invalid characters and still replies', async () => {
      await post(startUpdate(NEW_ID, 'a.b'))
      expect(lastReply()).toBe(tFor('en').bot.start)
      await post(startUpdate(NEW_ID, 'a b'))
      expect(await startsFor(NEW_ID)).toEqual([])
      expect(sendMessage).toHaveBeenCalledTimes(2)
    })

    it('keeps the first row when the same link is opened twice', async () => {
      await post(startUpdate(NEW_ID, 'insta'))
      const [{ first_at }] = await sql`select first_at from join_tag_starts`
      await post(startUpdate(NEW_ID, 'insta'))
      expect(await sql`select tag, first_at from join_tag_starts`).toEqual([{ tag: 'insta', first_at }])
    })

    it('still replies when recording the start fails', async () => {
      await failOn('join_tag_starts', 'insert')
      const res = await post(startUpdate(NEW_ID, 'insta'))
      expect(res.statusCode).toBe(200)
      expect(lastReply()).toBe(tFor('en').bot.start)
    })

    it('plain /start is not a tag', async () => {
      await post(startUpdate(NEW_ID))
      expect(lastReply()).toBe(tFor('en').bot.start)
      expect(await sql`select 1 from join_tag_starts`).toEqual([])
    })

    it('support keeps its prompt and is not a tag', async () => {
      await post(startUpdate(NEW_ID, 'support'))
      expect(lastReply()).toBe(tFor('en').support.prompt)
      expect(await sql`select 1 from join_tag_starts`).toEqual([])
    })

    it('ref_ values are not tags, even with an unknown code', async () => {
      await post(startUpdate(NEW_ID, 'ref_x'))
      await post(startUpdate(NEW_ID, 'ref_NOT.VALID'))
      await post(startUpdate(NEW_ID, 'REF_x'))
      expect(await sql`select 1 from join_tag_starts`).toEqual([])
      expect(sendMessage).toHaveBeenCalledTimes(3)
    })
  })

  describe('new accounts', () => {
    it('attributes a new account to the tag it opened', async () => {
      await post(startUpdate(NEW_ID, 'Insta'))
      expect((await newUser()).join_tag).toBe('insta')
    })

    it('first tag wins, and it never changes afterwards', async () => {
      await post(startUpdate(NEW_ID, 'first'))
      await post(startUpdate(NEW_ID, 'second'))
      const u = await newUser()
      expect(u.join_tag).toBe('first')

      await post(startUpdate(NEW_ID, 'third'))
      await signIn({ kind: 'telegram', tgUser: { id: NEW_ID, first_name: 'New' } })
      const [row] = await sql`select join_tag from users where id = ${u.id}`
      expect(row.join_tag).toBe('first')
      expect(await startsFor(NEW_ID)).toEqual([
        { tag: 'first', existing_user: false },
        { tag: 'second', existing_user: false },
        { tag: 'third', existing_user: true },
      ])
    })

    it('never attributes an existing user who opens a tag', async () => {
      const u = await createUser()
      await post(startUpdate(u.telegram_id, 'insta'))
      await signIn({ kind: 'telegram', tgUser: { id: u.telegram_id, first_name: 'Old' } })
      const [row] = await sql`select join_tag from users where id = ${u.id}`
      expect(row.join_tag).toBeNull()
    })

    it('ignores a start recorded while the person already had an account', async () => {
      await insertRow('join_tag_starts', { tag: 'insta', telegram_id: NEW_ID, existing_user: true })
      expect((await newUser()).join_tag).toBeNull()
    })

    it('leaves accounts with no tag unattributed', async () => {
      await post(startUpdate(999, 'insta'))
      expect((await newUser()).join_tag).toBeNull()
    })

    it('a Google account has no Telegram id to look up and signs in normally', async () => {
      const res = await signIn({ kind: 'google', sub: 'g-1', email: 'g@example.com', givenName: 'G' })
      expect(res.ok).toBe(true)
      const [row] = await sql`select join_tag from users where google_sub = 'g-1'`
      expect(row.join_tag).toBeNull()
    })

    it('signup survives a failed attribution', async () => {
      await post(startUpdate(NEW_ID, 'insta'))
      await failReadsOf('join_tag_starts')
      expect((await newUser()).join_tag).toBeNull()
    })
  })

  describe('alongside referrals', () => {
    it('leaves the ref_ flow unchanged', async () => {
      const referrer = await createUser({ referral_code: 'friend12' })
      await post(startUpdate(NEW_ID, 'ref_friend12'))
      expect(await sql`select code from referral_claims where telegram_id = ${NEW_ID}`).toEqual([{ code: 'friend12' }])
      const u = await newUser()
      expect(u.referred_by).toBe(referrer.id)
      expect(u.join_tag).toBeNull()
      expect(await sql`select referrer_id, referred_id from referrals`).toEqual([{ referrer_id: referrer.id, referred_id: u.id }])
      expect(await sql`select 1 from join_tag_starts`).toEqual([])
    })

    it('a user who opened both a ref and a tag link gets both', async () => {
      const referrer = await createUser({ referral_code: 'friend12' })
      await post(startUpdate(NEW_ID, 'ref_friend12'))
      await post(startUpdate(NEW_ID, 'insta'))
      const u = await newUser()
      expect(u.referred_by).toBe(referrer.id)
      expect(u.join_tag).toBe('insta')
    })
  })
})
