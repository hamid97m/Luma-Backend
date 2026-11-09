import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

const sendPhoto = vi.fn().mockResolvedValue(undefined)
const sendMessage = vi.fn().mockResolvedValue(undefined)
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({ api: { sendPhoto, sendMessage } })),
  InlineKeyboard: vi.fn().mockImplementation(function () { return { webApp() { return this } } }),
  Context: class {},
}))

import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'
import { initPush, __setPushTransportForTests } from '../src/push/fcm.js'
import {
  notifyUserMatch, notifyUserLike, deliverToUser, type NotifyUser,
  notifyUserGiftMessage, notifyUserGiftIntro, notifyUserReferralQualified, notifyUserReferralReward,
  notifyUserPremiumPurchased, notifyUserPaused, notifyUserPhotoWarning, notifyUserSupportReply, notifyUserText,
} from '../src/notify/userNotify.js'
import { pauseForPhotoReview } from '../src/moderation/autoPause.js'
import { runPurchaseMessageJob } from '../src/jobs/purchaseMessage.js'
import { createTx, ago } from './helpers/premium.js'
import { deliverMessageNotification } from '../src/messaging/deliver.js'
import { chatHub } from '../src/realtime/hub.js'
import { fa } from '../src/i18n/fa.js'
import { en } from '../src/i18n/en.js'

let tmp: string
let gSeq = 0
const googleUser = () => createUser({ telegram_id: null, google_sub: `g-${++gSeq}`, email: `g${gSeq}@x.test` })
const saved: Record<string, string | undefined> = {}
const envKeys = ['FCM_SERVICE_ACCOUNT_FILE', 'APP_MODE', 'WEB_URL', 'BOT_TOKEN'] as const
let isConnectedSpy: { mockRestore(): void } | undefined
let bodies: any[]
let status: number

async function enablePush() {
  const keyFile = path.join(tmp, 'sa.json')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  fs.writeFileSync(keyFile, JSON.stringify({
    type: 'service_account', project_id: 'proj-x', private_key: privateKey,
    client_email: 'sa@proj-x.iam.gserviceaccount.com',
  }))
  process.env.FCM_SERVICE_ACCOUNT_FILE = keyFile
  await initPush()
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of envKeys) saved[k] = process.env[k]
  process.env.WEB_URL = 'https://luma.test'
  process.env.BOT_TOKEN = 'x'
  delete process.env.APP_MODE
  await resetDb()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-notify-'))
  bodies = []
  status = 200
  __setPushTransportForTests(async (b) => { bodies.push(b); return { status, json: {} } })
  await enablePush()
})

afterEach(() => {
  __setPushTransportForTests(null)
  isConnectedSpy?.mockRestore()
  isConnectedSpy = undefined
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function addToken(userId: string, token = 'tok-' + userId) {
  await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at)
            values (${userId}, ${'d-' + token}, 'android', ${token}, now())`
}

function asNotifyUser(u: Record<string, any>): NotifyUser {
  return { id: u.id, telegram_id: u.telegram_id, allows_write_to_pm: u.allows_write_to_pm ?? null, locale: u.locale ?? null }
}

describe('notifyUserMatch', () => {
  it('pushes (no bot DM) to a Telegram user with a token', async () => {
    const u = await createUser({ locale: 'en' })
    await addToken(u.id)
    await notifyUserMatch(asNotifyUser(u), { matchName: 'Sara', matchPhoto: null, matchId: 'm1' })
    expect(bodies).toHaveLength(1)
    const msg = bodies[0].message
    expect(msg.data.type).toBe('match')
    expect(msg.data.link.endsWith('?screen=matches&chat=m1')).toBe(true)
    expect(msg.data.chatId).toBe('m1')
    expect(msg.notification).toEqual({ title: 'Sara', body: en.notify.match('Sara') })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendPhoto).not.toHaveBeenCalled()
  })

  it('sends exactly the old bot DM when the user has no token', async () => {
    const u = await createUser()
    await notifyUserMatch(asNotifyUser(u), { matchName: 'Sara', matchPhoto: 'https://p/s.jpg', matchId: 'm1', question: 'Q?' })
    expect(bodies).toHaveLength(0)
    expect(sendPhoto).toHaveBeenCalledTimes(1)
    const [chatId, photo, opts] = sendPhoto.mock.calls[0]
    expect(chatId).toBe(u.telegram_id)
    expect(photo).toBe('https://p/s.jpg')
    expect(opts.caption).toBe(fa.notify.matchWithQuestion('Sara', 'Q?'))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('pushes to a Google-only user with a token; with no token sends nothing and does not throw', async () => {
    const g = await googleUser()
    await addToken(g.id)
    await notifyUserMatch(asNotifyUser(g), { matchName: 'Sara', matchPhoto: null, matchId: 'm1' })
    expect(bodies).toHaveLength(1)

    const g2 = await googleUser()
    await expect(notifyUserMatch(asNotifyUser(g2), { matchName: 'Sara', matchPhoto: null })).resolves.toBeUndefined()
    expect(bodies).toHaveLength(1)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendPhoto).not.toHaveBeenCalled()
  })

  it('falls back to the bot DM when every token is dead', async () => {
    status = 404
    const u = await createUser()
    await addToken(u.id)
    await notifyUserMatch(asNotifyUser(u), { matchName: 'Sara', matchPhoto: null, matchId: 'm1' })
    expect(bodies).toHaveLength(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toBe(fa.notify.match('Sara'))
  })
})

describe('stale devices (unseen for 14+ days)', () => {
  it('pushes to a 20-day-old device AND still sends the bot DM', async () => {
    const u = await createUser()
    await addToken(u.id)
    await sql`update user_devices set last_seen_at = now() - interval '20 days' where user_id = ${u.id}`
    const r = await deliverToUser(asNotifyUser(u), { type: 'match', title: 'Sara', body: 'hi', link: '' },
      () => sendMessage(u.telegram_id, 'dm'))
    expect(bodies).toHaveLength(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(r).toBe('bot')
  })

  it('a fresh device gets the push only', async () => {
    const u = await createUser()
    await addToken(u.id)
    await sql`update user_devices set last_seen_at = now() - interval '13 days' where user_id = ${u.id}`
    const r = await deliverToUser(asNotifyUser(u), { type: 'match', title: 'Sara', body: 'hi', link: '' },
      () => sendMessage(u.telegram_id, 'dm'))
    expect(bodies).toHaveLength(1)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(r).toBe('push')
  })
})

describe('notifyUserLike', () => {
  it('pushes a like with the liker name as title and links to likes', async () => {
    const u = await createUser({ locale: 'en' })
    await addToken(u.id)
    expect(await notifyUserLike(asNotifyUser(u), 'Sara', 'like_reveal')).toBe('push')
    const msg = bodies[0].message
    expect(msg.data.type).toBe('like_reveal')
    expect(msg.data.screen).toBe('likes')
    expect(msg.notification).toEqual({ title: 'Sara', body: en.notify.newLike('Sara') })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('rethrows bot errors on the DM fallback', async () => {
    const u = await createUser()
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('blocked'), { error_code: 403 }))
    await expect(notifyUserLike(asNotifyUser(u), 'Sara', 'like')).rejects.toThrow('blocked')
  })
})

describe('deliverToUser', () => {
  it('treats a rejecting push as zero sent and falls through to the bot', async () => {
    const u = await createUser()
    await addToken(u.id)
    // A dead token whose pruning fails → sendPushToUser rejects.
    status = 404
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const realSql = sql
    await realSql`alter table user_devices add constraint t_block_prune check (push_token is not null) not valid`
    try {
      const botSend = vi.fn().mockResolvedValue(undefined)
      expect(await deliverToUser(asNotifyUser(u), { type: 'test', title: 't', body: 'b', link: 'x' }, botSend)).toBe('bot')
      expect(botSend).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls.some((c) => String(c[0]).startsWith('[notify] push'))).toBe(true)
    } finally {
      await realSql`alter table user_devices drop constraint t_block_prune`
      spy.mockRestore()
    }
  })

  it('returns none for a fake (negative telegram_id) without a token', async () => {
    const u = await createUser({ telegram_id: -5 })
    const botSend = vi.fn()
    expect(await deliverToUser(asNotifyUser(u), { type: 'test', title: 't', body: 'b', link: 'x' }, botSend)).toBe('none')
    expect(botSend).not.toHaveBeenCalled()
  })
})

describe('deliverMessageNotification', () => {
  async function setup() {
    const sender = await createUser({ name: 'Sara' })
    const rec = await createUser({ gender: 'man' })
    const m = await createMatch(sender.id, rec.id)
    const recipient = {
      id: rec.id, telegram_id: rec.telegram_id, last_active: null, notified_offline_at: null,
      allows_write_to_pm: null, locale: null, gender: 'man',
    }
    return { sender, rec, m, recipient }
  }

  it('sends nothing while the recipient has an open stream', async () => {
    const { sender, rec, m, recipient } = await setup()
    await addToken(rec.id)
    isConnectedSpy = vi.spyOn(chatHub, 'isOnline').mockImplementation((id) => id === rec.id)
    await deliverMessageNotification(recipient, sender.id, 'Sara', 'hi', m.id)
    expect(bodies).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalled()
    const [row] = await sql`select notified_offline_at from users where id = ${rec.id}`
    expect(row.notified_offline_at).toBeNull()
  })

  it('offline: pushes with chatId and stamps notified_offline_at', async () => {
    const { sender, rec, m, recipient } = await setup()
    await addToken(rec.id)
    await deliverMessageNotification(recipient, sender.id, 'Sara', 'hi', m.id)
    expect(bodies).toHaveLength(1)
    const msg = bodies[0].message
    expect(msg.data.type).toBe('message')
    expect(msg.data.chatId).toBe(m.id)
    expect(msg.data.screen).toBe('matches')
    expect(msg.notification).toEqual({ title: 'Sara', body: 'hi' })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendPhoto).not.toHaveBeenCalled()
    const [row] = await sql`select notified_offline_at from users where id = ${rec.id}`
    expect(row.notified_offline_at).not.toBeNull()
  })

  it('pushes to an offline Google-only recipient', async () => {
    const { sender, rec, m, recipient } = await setup()
    await sql`update users set telegram_id = null, google_sub = ${'g-rec-' + rec.id} where id = ${rec.id}`
    await addToken(rec.id)
    await deliverMessageNotification({ ...recipient, telegram_id: null }, sender.id, 'Sara', 'hi', m.id)
    expect(bodies).toHaveLength(1)
  })

  describe('not online but active within the last minute', () => {
    const oneMinAgo = () => new Date(Date.now() - 60_000).toISOString()

    it('pushes right away (no 10-minute wait) and stamps notified_offline_at', async () => {
      const { sender, rec, m, recipient } = await setup()
      await addToken(rec.id)
      await deliverMessageNotification({ ...recipient, last_active: oneMinAgo() }, sender.id, 'Sara', 'hi', m.id)
      expect(bodies).toHaveLength(1)
      expect(bodies[0].message.data.chatId).toBe(m.id)
      const [row] = await sql`select notified_offline_at from users where id = ${rec.id}`
      expect(row.notified_offline_at).not.toBeNull()
    })

    it('still sends nothing while the recipient has an open stream', async () => {
      const { sender, rec, m, recipient } = await setup()
      await addToken(rec.id)
      isConnectedSpy = vi.spyOn(chatHub, 'isOnline').mockImplementation((id) => id === rec.id)
      await deliverMessageNotification({ ...recipient, last_active: oneMinAgo() }, sender.id, 'Sara', 'hi', m.id)
      expect(bodies).toHaveLength(0)
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('sends the Telegram bot DM right away when there is no push token', async () => {
      const { sender, rec, m, recipient } = await setup()
      await deliverMessageNotification({ ...recipient, last_active: oneMinAgo() }, sender.id, 'Sara', 'hi', m.id)
      expect(bodies).toHaveLength(0)
      expect(sendMessage.mock.calls.length + sendPhoto.mock.calls.length).toBe(1)
      const [row] = await sql`select notified_offline_at from users where id = ${rec.id}`
      expect(row.notified_offline_at).not.toBeNull()
    })

    it('falls back to the bot DM right away when every push fails', async () => {
      const { sender, rec, m, recipient } = await setup()
      await addToken(rec.id)
      status = 500
      await deliverMessageNotification({ ...recipient, last_active: oneMinAgo() }, sender.id, 'Sara', 'hi', m.id)
      expect(sendMessage.mock.calls.length + sendPhoto.mock.calls.length).toBe(1)
    })

    it('pushes a woman for every message too (no 4-hour limit)', async () => {
      const { sender, rec, m, recipient } = await setup()
      await addToken(rec.id)
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
      await deliverMessageNotification(
        { ...recipient, gender: 'woman', last_active: oneMinAgo(), notified_offline_at: hourAgo },
        sender.id, 'Sara', 'hi', m.id,
      )
      expect(bodies).toHaveLength(1)
    })
  })
})

describe('Telegram-style message notifications', () => {
  const dms = () => sendMessage.mock.calls.length + sendPhoto.mock.calls.length
  const botRows = (userId: string) =>
    sql`select match_id, channel, sent_at from message_notifications where user_id = ${userId} order by sent_at`

  async function pair(gender: string, opts: { token?: boolean } = {}) {
    const sender = await createUser({ name: 'Sara' })
    const rec = await createUser({ gender })
    const m = await createMatch(sender.id, rec.id)
    if (opts.token) await addToken(rec.id)
    const recipient = {
      id: rec.id, telegram_id: rec.telegram_id, last_active: null as string | null, notified_offline_at: null,
      allows_write_to_pm: null, locale: null, gender,
    }
    return { sender, rec, m, recipient }
  }

  /** Insert a message row (as the route does before notifying) and notify. */
  async function say(p: { sender: any; m: any; recipient: any }, body: string, recipient = p.recipient) {
    await insertRow('messages', { match_id: p.m.id, sender_id: p.sender.id, body })
    await deliverMessageNotification(recipient, p.sender.id, 'Sara', body, p.m.id)
  }

  it('woman with a token: every message in a chat is pushed, tagged by chat, with the unread count', async () => {
    const p = await pair('woman', { token: true })
    await say(p, 'one')
    await say(p, 'two')
    await say(p, 'three')
    expect(bodies).toHaveLength(3)
    for (const b of bodies) {
      expect(b.message.android.notification.tag).toBe(p.m.id)
      expect(b.message.notification.title).toBe('Sara')
    }
    expect(bodies.map((b) => b.message.data.unread)).toEqual(['1', '2', '3'])
    expect(bodies.map((b) => b.message.notification.body)).toEqual(['one', 'two', 'three'])
    expect(dms()).toBe(0)
  })

  it('unread counts only the unread messages from the sender in that chat', async () => {
    const p = await pair('woman', { token: true })
    await insertRow('messages', { match_id: p.m.id, sender_id: p.sender.id, body: 'old', read_at: new Date().toISOString() })
    await insertRow('messages', { match_id: p.m.id, sender_id: p.rec.id, body: 'mine' })
    const elsewhere = await createMatch(p.sender.id, (await createUser()).id)
    await insertRow('messages', { match_id: elsewhere.id, sender_id: p.sender.id, body: 'other chat' })
    await say(p, 'new')
    expect(bodies[0].message.data.unread).toBe('1')
  })

  it('man with a token: 3 messages → 3 pushes, no bot rows recorded', async () => {
    const p = await pair('man', { token: true })
    await say(p, 'a'); await say(p, 'b'); await say(p, 'c')
    expect(bodies).toHaveLength(3)
    expect(await botRows(p.rec.id)).toHaveLength(0)
  })

  for (const gender of ['man', 'woman']) {
    it(`${gender} without a token: bot DM at most once per chat per 10 minutes, reset by activity`, async () => {
      const p = await pair(gender)
      await say(p, 'a'); await say(p, 'b'); await say(p, 'c')
      expect(dms()).toBe(1)
      const rows = await botRows(p.rec.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ match_id: p.m.id, channel: 'bot' })

      // Active after that DM → the next message DMs again.
      const activeAfter = new Date(new Date(rows[0].sent_at).getTime() + 1000).toISOString()
      await say(p, 'd', { ...p.recipient, last_active: activeAfter })
      expect(dms()).toBe(2)
      // Not active since (last_active before the DM) → still held back.
      await say(p, 'e', { ...p.recipient, last_active: new Date(Date.now() - 3_600_000).toISOString() })
      expect(dms()).toBe(2)

      // 11 minutes later → DMs again.
      await sql`update message_notifications set sent_at = now() - interval '11 minutes' where user_id = ${p.rec.id}`
      await say(p, 'f')
      expect(dms()).toBe(3)
    })
  }

  it('the bot window is per chat: another chat DMs right away', async () => {
    const p = await pair('woman')
    await say(p, 'a')
    const sender2 = await createUser({ name: 'Mina' })
    const m2 = await createMatch(sender2.id, p.rec.id)
    await say({ sender: sender2, m: m2, recipient: p.recipient }, 'b')
    expect(dms()).toBe(2)
  })

  it('online recipient → nothing sent and no row recorded', async () => {
    const p = await pair('man')
    isConnectedSpy = vi.spyOn(chatHub, 'isOnline').mockImplementation((id) => id === p.rec.id)
    await say(p, 'a')
    expect(dms()).toBe(0)
    expect(bodies).toHaveLength(0)
    expect(await botRows(p.rec.id)).toHaveLength(0)
  })

  it('race: two concurrent deliveries in one chat for a Telegram-only user → exactly 1 bot DM', async () => {
    const p = await pair('man')
    await insertRow('messages', { match_id: p.m.id, sender_id: p.sender.id, body: 'x' })
    await Promise.all([
      deliverMessageNotification(p.recipient, p.sender.id, 'Sara', 'x', p.m.id),
      deliverMessageNotification(p.recipient, p.sender.id, 'Sara', 'y', p.m.id),
    ])
    expect(dms()).toBe(1)
    expect(await botRows(p.rec.id)).toHaveLength(1)
  })

  it('a push that fails for every token falls back to the bot DM under the per-chat rule; no push row', async () => {
    status = 400 // plain failure, no retry
    const p = await pair('woman', { token: true })
    await say(p, 'a'); await say(p, 'b')
    expect(bodies).toHaveLength(2)
    expect(dms()).toBe(1)
    const rows = await botRows(p.rec.id)
    expect(rows.map((r) => r.channel)).toEqual(['bot'])
  })

  it('a failed bot send releases the claim so the next message can DM', async () => {
    const p = await pair('man')
    sendMessage.mockRejectedValueOnce(new Error('blocked'))
    await say(p, 'a')
    expect(await botRows(p.rec.id)).toHaveLength(0)
    await say(p, 'b')
    expect(await botRows(p.rec.id)).toHaveLength(1)
  })

  it('rows older than 2 days are deleted on the next insert for that user', async () => {
    const p = await pair('man')
    const other = await createMatch((await createUser()).id, p.rec.id)
    await sql`insert into message_notifications (user_id, match_id, channel, sent_at)
              values (${p.rec.id}, ${other.id}, 'bot', now() - interval '3 days')`
    const keep = await createUser()
    const keepMatch = await createMatch((await createUser()).id, keep.id)
    await sql`insert into message_notifications (user_id, match_id, channel, sent_at)
              values (${keep.id}, ${keepMatch.id}, 'bot', now() - interval '3 days')`
    await say(p, 'a')
    const rows = await botRows(p.rec.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].match_id).toBe(p.m.id)
    expect(await botRows(keep.id)).toHaveLength(1)
  })
})

describe('push not configured', () => {
  beforeEach(async () => {
    delete process.env.FCM_SERVICE_ACCOUNT_FILE
    await initPush()
  })

  it('match, like and message use the bot path even with a token', async () => {
    const u = await createUser()
    await addToken(u.id)
    await notifyUserMatch(asNotifyUser(u), { matchName: 'Sara', matchPhoto: null, matchId: 'm1' })
    expect(await notifyUserLike(asNotifyUser(u), 'Sara', 'like')).toBe('bot')
    const sender = await createUser()
    const m = await createMatch(sender.id, u.id)
    await deliverMessageNotification(
      { id: u.id, telegram_id: u.telegram_id, last_active: null, notified_offline_at: null, allows_write_to_pm: null, gender: 'man' },
      sender.id, 'Sara', 'hi', m.id,
    )
    expect(bodies).toHaveLength(0)
    expect(sendMessage.mock.calls.map((c) => c[1])).toEqual([
      fa.notify.match('Sara'), fa.notify.newLike('Sara'), fa.notify.newMessage('Sara', 'hi'),
    ])
  })

  it('Google-only user: nothing sent, nothing thrown', async () => {
    const g = await googleUser()
    await notifyUserMatch(asNotifyUser(g), { matchName: 'Sara', matchPhoto: null })
    expect(await notifyUserLike(asNotifyUser(g), 'Sara', 'like')).toBe('none')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('remaining notification types', () => {
  const opened = { reply_markup: expect.anything() }
  const cases: Array<{
    name: string
    call: (u: NotifyUser) => Promise<'push' | 'bot' | 'none'>
    type: string
    title: string
    body: string
    screen?: string
    botText: string
  }> = [
    {
      name: 'notifyUserGiftMessage', call: (u) => notifyUserGiftMessage(u, 'Ali', '🌹'), type: 'gift_message',
      title: en.push.title.gift, body: en.notify.newMessage('Ali', en.gifts.sentYouGift('🌹')), screen: 'matches',
      botText: fa.notify.newMessage('Ali', fa.gifts.sentYouGift('🌹')),
    },
    {
      name: 'notifyUserGiftIntro', call: (u) => notifyUserGiftIntro(u, 'Ali', '🌹'), type: 'gift_intro',
      title: en.push.title.gift, body: en.notify.giftIntro('Ali', '🌹'), botText: fa.notify.giftIntro('Ali', '🌹'),
    },
    {
      name: 'notifyUserReferralQualified', call: (u) => notifyUserReferralQualified(u, 'Sara'), type: 'referral_qualified',
      title: en.push.title.referralQualified, body: en.referral.qualified('Sara'), botText: fa.referral.qualified('Sara'),
    },
    {
      name: 'notifyUserReferralReward', call: (u) => notifyUserReferralReward(u, { rewardType: 'premium_days', rewardAmount: 7 }),
      type: 'referral_reward', title: en.push.title.referralReward, body: en.referral.rewardPremium(7),
      botText: fa.referral.rewardPremium(7),
    },
    {
      name: 'notifyUserReferralReward (swipes)', call: (u) => notifyUserReferralReward(u, { rewardType: 'swipes', rewardAmount: 20 }),
      type: 'referral_reward', title: en.push.title.referralReward, body: en.referral.rewardSwipes(20),
      botText: fa.referral.rewardSwipes(20),
    },
    {
      name: 'notifyUserPremiumPurchased', call: (u) => notifyUserPremiumPurchased(u, 30), type: 'premium_purchased',
      title: en.push.title.premiumPurchased, body: en.premium.purchased(30), botText: fa.premium.purchased(30),
    },
    {
      name: 'notifyUserPaused', call: (u) => notifyUserPaused(u), type: 'account_paused',
      title: en.push.title.accountPaused, body: en.notify.paused, botText: fa.notify.paused,
    },
    {
      name: 'notifyUserPhotoWarning (man)', call: (u) => notifyUserPhotoWarning(u, 'man'), type: 'photo_warning',
      title: en.push.title.photoWarning, body: en.notify.fakePhotoWarningMan, screen: 'profile',
      botText: fa.notify.fakePhotoWarningMan,
    },
    {
      name: 'notifyUserPhotoWarning (woman)', call: (u) => notifyUserPhotoWarning(u, 'woman'), type: 'photo_warning',
      title: en.push.title.photoWarning, body: en.notify.fakePhotoWarningWoman, screen: 'profile',
      botText: fa.notify.fakePhotoWarningWoman,
    },
    {
      name: 'notifyUserSupportReply', call: (u) => notifyUserSupportReply(u, 'Where is my chat?', 'Fixed now'), type: 'support_reply',
      title: en.push.title.supportReply, body: en.support.ticketReply('Where is my chat?', 'Fixed now'),
      botText: fa.support.ticketReply('Where is my chat?', 'Fixed now'),
    },
  ]

  for (const c of cases) {
    it(`${c.name}: pushes only, with type/title/link, when the user has a token`, async () => {
      const u = await createUser({ locale: 'en' })
      await addToken(u.id)
      expect(await c.call(asNotifyUser(u))).toBe('push')
      expect(bodies).toHaveLength(1)
      const msg = bodies[0].message
      expect(msg.data.type).toBe(c.type)
      expect(msg.notification).toEqual({ title: c.title, body: c.body.replace(/<[^>]*>/g, '') })
      if (c.screen) {
        expect(msg.data.screen).toBe(c.screen)
        expect(msg.data.link).toBe(`https://luma.test/?screen=${c.screen}`)
      } else {
        expect(msg.data.screen).toBeUndefined()
        expect(msg.data.link).toBe('https://luma.test')
      }
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it(`${c.name}: sends today's exact bot DM without a token`, async () => {
      const u = await createUser()
      expect(await c.call(asNotifyUser(u))).toBe('bot')
      expect(bodies).toHaveLength(0)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(u.telegram_id, c.botText, opened)
    })
  }

  describe('DMs that never checked allows_write_to_pm keep doing so', () => {
    const optOut = [
      { name: 'gift_message', call: (u: NotifyUser) => notifyUserGiftMessage(u, 'Ali', '🌹'),
        text: fa.notify.newMessage('Ali', fa.gifts.sentYouGift('🌹')) },
      { name: 'gift_intro', call: (u: NotifyUser) => notifyUserGiftIntro(u, 'Ali', '🌹'), text: fa.notify.giftIntro('Ali', '🌹') },
      { name: 'premium_purchased', call: (u: NotifyUser) => notifyUserPremiumPurchased(u, 30), text: fa.premium.purchased(30) },
    ]
    for (const c of optOut) {
      it(`${c.name}: Telegram user with allows_write_to_pm=false and no token still gets the bot DM`, async () => {
        const u = await createUser({ allows_write_to_pm: false })
        expect(await c.call(asNotifyUser(u))).toBe('bot')
        expect(sendMessage).toHaveBeenCalledWith(u.telegram_id, c.text, { reply_markup: expect.anything() })
      })
    }

    it('the shared rule still applies elsewhere (paused: opted-out → none)', async () => {
      const u = await createUser({ allows_write_to_pm: false })
      expect(await notifyUserPaused(asNotifyUser(u))).toBe('none')
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  it('Google-only user with no token: nothing sent, returns none', async () => {
    const g = await googleUser()
    expect(await notifyUserPaused(asNotifyUser(g))).toBe('none')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('rethrows bot errors where the bot function throws', async () => {
    const u = await createUser()
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('blocked'), { error_code: 403 }))
    await expect(notifyUserPaused(asNotifyUser(u))).rejects.toThrow('blocked')
  })

  describe('notifyUserText', () => {
    it('pushes an admin message with the given title and the button screen', async () => {
      const u = await createUser({ locale: 'en' })
      await addToken(u.id)
      const r = await notifyUserText(asNotifyUser(u), {
        type: 'admin_message', title: 'Hello', text: 'come back',
        button: { title: 'Plans', kind: 'screen', screen: 'plans' },
      })
      expect(r).toBe('push')
      const msg = bodies[0].message
      expect(msg.data.type).toBe('admin_message')
      expect(msg.data.screen).toBe('plans')
      expect(msg.data.link).toBe('https://luma.test/?screen=plans')
      expect(msg.notification).toEqual({ title: 'Hello', body: 'come back' })
    })

    it('falls back to the app title and carries a url button', async () => {
      const u = await createUser({ locale: 'en' })
      await addToken(u.id)
      await notifyUserText(asNotifyUser(u), {
        type: 'purchase_reminder', title: '  ', text: 'hi',
        button: { title: 'Site', kind: 'url', url: 'https://x.test/a' },
      })
      const msg = bodies[0].message
      expect(msg.notification.title).toBe(en.push.title.app)
      expect(msg.data.url).toBe('https://x.test/a')
      expect(msg.data.link).toBe('https://luma.test')
    })

    it('without a token sends exactly sendBroadcastMessage', async () => {
      const u = await createUser()
      expect(await notifyUserText(asNotifyUser(u), { type: 'admin_message', text: 'plain' })).toBe('bot')
      expect(sendMessage).toHaveBeenCalledWith(u.telegram_id, 'plain', {})
    })
  })

  it('a paused user with a token gets the account_paused push (no DM)', async () => {
    const u = await createUser({ locale: 'en' })
    await addToken(u.id)
    expect(await pauseForPhotoReview(u.id)).toBe(true)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].message.data.type).toBe('account_paused')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a paused Google-only user with a token gets the push too', async () => {
    const g = await googleUser()
    await addToken(g.id)
    expect(await pauseForPhotoReview(g.id)).toBe(true)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].message.data.type).toBe('account_paused')
  })

  describe('purchase-message job', () => {
    const cfg = {
      enabled: true, kind: 'text' as const, message: 'come back!', button: null,
      sourceChatId: null, sourceMessageId: null, activeSince: '2026-01-01T00:00:00.000Z', translations: {},
    }

    async function googleAbandoner() {
      const g = await createUser({ telegram_id: null, google_sub: `g-${++gSeq}`, email: `g${gSeq}@x.test`, geo_country: 'IR' })
      await addToken(g.id)
      await createTx(g.id, { created_at: ago(10 * 60 * 1000) })
      return g
    }

    it('text mode: pushes a purchase_reminder to a Google-only user with a token', async () => {
      await googleAbandoner()
      const stats = await runPurchaseMessageJob({ getConfig: async () => cfg })
      expect(stats).toMatchObject({ eligible: 1, sent: 1 })
      expect(bodies).toHaveLength(1)
      const msg = bodies[0].message
      expect(msg.data.type).toBe('purchase_reminder')
      expect(msg.notification).toEqual({ title: fa.push.title.app, body: 'come back!' })
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('forward mode: skips a Google-only user', async () => {
      await googleAbandoner()
      const forward = vi.fn(() => Promise.resolve())
      const stats = await runPurchaseMessageJob({
        getConfig: async () => ({ ...cfg, kind: 'forward' as const, sourceChatId: '-100', sourceMessageId: 5 }),
        forward,
      })
      expect(stats.eligible).toBe(0)
      expect(forward).not.toHaveBeenCalled()
      expect(bodies).toHaveLength(0)
    })
  })
})
