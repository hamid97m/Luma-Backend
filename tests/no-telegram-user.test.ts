import { describe, it, expect, vi, beforeEach } from 'vitest'

// Website users (signed in with Google/email) have no Telegram account:
// users.telegram_id IS NULL. They must never break a route, never be sent a bot
// message, and never land in a bot broadcast / purchase-message audience.

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({
  notifyMatch: vi.fn().mockResolvedValue(undefined),
  notifyNewLike: vi.fn().mockResolvedValue(undefined),
  notifyNewMessage: vi.fn().mockResolvedValue(undefined),
  notifyPaused: vi.fn().mockResolvedValue(undefined),
  notifyGiftIntro: vi.fn().mockResolvedValue(undefined),
  notifyPaymentChannel: vi.fn().mockResolvedValue(undefined),
  sendBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  forwardBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  fetchTelegramProfilePhoto: vi.fn(),
  getGiftCatalog: vi.fn(),
  createGiftInvoiceLink: vi.fn().mockResolvedValue('https://t.me/invoice/abc'),
  sendGiftToUser: vi.fn().mockResolvedValue(undefined),
  refundGift: vi.fn().mockResolvedValue(undefined),
  getBotUsername: vi.fn().mockReturnValue('luma_bot'),
}))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import {
  notifyMatch, notifyNewLike, notifyNewMessage, notifyPaused, fetchTelegramProfilePhoto,
  getGiftCatalog, sendGiftToUser, refundGift, sendBroadcastMessage,
} from '../src/bot.js'
import { signSessionToken } from '../src/session.js'
import { fetchAudience, countAudience } from '../src/messaging/audience.js'
import { runPurchaseMessageJob } from '../src/jobs/purchaseMessage.js'
import type { PurchaseMessageConfig } from '../src/jobs/purchaseMessageConfig.js'
import { handleGiftPaid } from '../src/gifts/service.js'
import { AUTH, authAs } from './helpers/auth.js'
import { adminHeaders } from './helpers/admin.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'
import { createTx, ago } from './helpers/premium.js'
import { createGiftTx } from './helpers/gifts-referrals.js'

const STALE = () => new Date(Date.now() - 20 * 60 * 1000).toISOString() // offline → DM-eligible if on Telegram
const bearer = (userId: string) => ({ authorization: `Bearer ${signSessionToken(userId)}` })
/** Let fire-and-forget notification chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 100))

let app: Awaited<ReturnType<typeof buildApp>>
/** A website-only user: no Telegram account. */
let web: Record<string, any>
/** A regular Telegram user. */
let tg: Record<string, any>

beforeEach(async () => {
  vi.clearAllMocks()
  await resetDb()
  app = await buildApp()
  web = await createUser({
    name: 'Web', telegram_id: null, google_sub: 'g-1', email: 'w@x.com',
    gender: 'man', looking_for: 'women', last_active: STALE(),
  })
  tg = await createUser({ name: 'Sara', gender: 'woman', looking_for: 'men', last_active: STALE() })
  authAs(tg)
})

describe('chat with a web-only user', () => {
  it('message to a web-only user succeeds and calls no bot send', async () => {
    const match = await createMatch(tg.id, web.id)
    const res = await app.inject({
      method: 'POST', url: `/matches/${match.id}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })

  it('a web-only user can message a Telegram user, who still gets the DM', async () => {
    const match = await createMatch(tg.id, web.id)
    await sql`update users set gender = 'woman', looking_for = 'men' where id = ${web.id}` // exempt from the chat limit
    const res = await app.inject({
      method: 'POST', url: `/matches/${match.id}/messages`, headers: bearer(web.id), payload: { body: 'hi' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(notifyNewMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyNewMessage).mock.calls[0][0]).toBe(tg.telegram_id)
  })

  it('admin send-as-fake to a web-only user succeeds and calls no bot send', async () => {
    const fake = await createUser({ name: 'Fake', is_seed: true, telegram_id: -7, gender: 'woman', looking_for: 'men' })
    const match = await createMatch(fake.id, web.id)
    const res = await app.inject({
      method: 'POST', url: `/admin/chats/${match.id}/messages`, headers: adminHeaders(), payload: { body: 'salam' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(notifyNewMessage).not.toHaveBeenCalled()
  })
})

describe('matching with a web-only user', () => {
  it('match with a web-only user succeeds and sends no bot match DM', async () => {
    await insertRow('swipes', { swiper_id: web.id, swiped_id: tg.id, direction: 'like' })
    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH, payload: { targetUserId: web.id, direction: 'like' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ matched: true, match: { user: { id: web.id } } })
    expect(res.json().match.user).not.toHaveProperty('telegramId')
    expect(notifyMatch).not.toHaveBeenCalled()
  })

  it('a web-only swiper matching a Telegram user still DMs the Telegram user', async () => {
    await insertRow('swipes', { swiper_id: tg.id, swiped_id: web.id, direction: 'like' })
    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: bearer(web.id), payload: { targetUserId: tg.id, direction: 'like' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ matched: true })
    expect(notifyMatch).toHaveBeenCalledWith([expect.objectContaining({ telegramId: tg.telegram_id })])
  })

  it('liking a web-only man sends no new-like DM', async () => {
    const res = await app.inject({
      method: 'POST', url: '/swipes', headers: AUTH, payload: { targetUserId: web.id, direction: 'like' },
    })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(notifyNewLike).not.toHaveBeenCalled()
  })

  it('GET /matches lists a web-only partner', async () => {
    await createMatch(tg.id, web.id)
    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().matches).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: web.id }) })])
  })
})

describe('bot audiences', () => {
  it('broadcast audience excludes web-only users', async () => {
    const targets = await fetchAudience({})
    expect(targets.map((t) => t.id)).toEqual([tg.id])
    expect(await countAudience({})).toBe(1)
  })

  it('purchase-message audience excludes web-only users', async () => {
    const cfg: PurchaseMessageConfig = {
      enabled: true, kind: 'text', message: 'come back!', button: null,
      sourceChatId: null, sourceMessageId: null, activeSince: '2026-01-01T00:00:00.000Z', translations: {},
    }
    await sql`update users set geo_country = 'IR' where id in ${sql([web.id, tg.id])}`
    await createTx(web.id, { created_at: ago(10 * 60 * 1000) })
    await createTx(tg.id, { created_at: ago(10 * 60 * 1000) })
    const sendText = vi.fn(() => Promise.resolve())
    await runPurchaseMessageJob({ getConfig: async () => cfg, sendText })
    expect(sendText).toHaveBeenCalledTimes(1)
    expect((sendText.mock.calls[0] as any[])[0]).toBe(tg.telegram_id)
  })

  it('admin direct message to a web-only user → 400 not_messageable, no bot send', async () => {
    const res = await app.inject({
      method: 'POST', url: `/admin/users/${web.id}/message`, headers: adminHeaders(), payload: { text: 'hello' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_messageable' })
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('admin pause of a web-only user succeeds and sends no bot DM', async () => {
    const res = await app.inject({ method: 'POST', url: `/admin/users/${web.id}/pause`, headers: adminHeaders() })
    await settle()
    expect(res.statusCode).toBe(200)
    expect(notifyPaused).not.toHaveBeenCalled()
  })
})

describe('Telegram-only features', () => {
  it('POST /profile/me/photos/from-telegram for web-only user → 400 no_telegram', async () => {
    const res = await app.inject({
      method: 'POST', url: '/profile/me/photos/from-telegram', headers: bearer(web.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'no_telegram' })
    expect(fetchTelegramProfilePhoto).not.toHaveBeenCalled()
  })

  it('gift checkout to a web-only recipient → 400 recipient_unavailable (Star gifts need Telegram)', async () => {
    vi.mocked(getGiftCatalog).mockResolvedValue([{ id: 'rose', sticker: { emoji: '🌹' }, star_count: 15 }] as any)
    const match = await createMatch(tg.id, web.id)
    for (const payload of [
      { context: 'chat', matchId: match.id, giftId: 'rose' },
      { context: 'discovery', targetUserId: web.id, giftId: 'rose' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/gifts/checkout', headers: AUTH, payload })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'recipient_unavailable' })
    }
    expect((await sql`select count(*)::int as n from gift_transactions`)[0].n).toBe(0)
  })

  it('a paid gift for a web-only recipient is refunded without calling the bot gift send', async () => {
    const tx = await createGiftTx(tg.id, web.id)
    await handleGiftPaid(tx.id, 'charge_1', tg.telegram_id, 20)
    expect(sendGiftToUser).not.toHaveBeenCalled()
    expect(refundGift).toHaveBeenCalledWith(tg.telegram_id, 'charge_1')
    const [row] = await sql`select status from gift_transactions where id = ${tx.id}`
    expect(row.status).toBe('refunded')
  })
})
