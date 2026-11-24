import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
const bot = vi.hoisted(() => ({
  notifyNewLike: vi.fn(async () => {}), notifyLikesUnlocked: vi.fn(async () => {}),
  notifyReferralQualified: vi.fn(async () => {}), notifyReferralReward: vi.fn(async () => {}),
  getBotUsername: vi.fn(() => 'LumaBot'),
}))
vi.mock('../src/bot.js', () => bot)

import { buildApp } from '../src/server.js'
import { upload } from '../src/storage.js'
import { hiddenIncomingLikerIds } from '../src/likes/reveal.js'
import { grantFriendLikeDays, grantAfterPhotoCheck } from '../src/likes/unlock.js'
import { decodeBlurToken, encodeBlurToken } from '../src/likes/blurredPhoto.js'
import { maybeQualifyReferral } from '../src/referrals/rewards.js'
import { captureAskAttribution } from '../src/asks/service.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createPhoto, insertRow, sql } from './helpers/db.js'
import { like } from './helpers/discovery.js'

const DAY = 86_400_000
let her: Record<string, any>
const likers: string[] = []

async function addLiker(extra: Record<string, unknown> = {}, photos = 1) {
  const u = await createUser({ name: 'SecretAli', gender: 'man', looking_for: 'women', ...extra })
  for (let i = 0; i < photos; i++) await createPhoto(u.id, i)
  await like(u, her)
  likers.push(u.id)
  return u
}

async function friend(extra: Record<string, unknown> = {}, qualified = true, referrer = her) {
  const f = await createUser({ name: 'Friend', gender: 'woman', looking_for: 'men', referred_by: referrer.id, ...extra })
  const photo = await createPhoto(f.id, 0)
  await sql`insert into referrals (referrer_id, referred_id, qualified_at)
    values (${referrer.id}, ${f.id}, ${qualified ? new Date().toISOString() : null})`
  return { ...f, photoId: photo.id } as Record<string, any>
}

const daysLeft = async () => {
  const [u] = await sql<{ likes_unlocked_until: string | null }[]>`select likes_unlocked_until from users where id = ${her.id}`
  return u.likes_unlocked_until ? Math.round((new Date(u.likes_unlocked_until).getTime() - Date.now()) / DAY) : 0
}

beforeEach(async () => {
  await resetDb()
  likers.length = 0
  vi.clearAllMocks()
  delete process.env.DEEPSEEK_API_KEY
  await sql`update referral_config set enabled = true`
  her = await createUser({ name: 'Her', gender: 'woman', looking_for: 'men', allows_write_to_pm: true, locale: 'fa' })
  authAs(her)
})
afterEach(() => { delete process.env.DEEPSEEK_API_KEY })

describe('grantFriendLikeDays', () => {
  it('pays 7 days once per qualified woman friend, and tells her', async () => {
    await friend()
    await Promise.all([grantFriendLikeDays(her.id), grantFriendLikeDays(her.id), grantFriendLikeDays(her.id)])
    expect(await daysLeft()).toBe(7)
    expect(bot.notifyLikesUnlocked).toHaveBeenCalledTimes(1)
    expect(bot.notifyLikesUnlocked).toHaveBeenCalledWith(her.telegram_id, 7, 'fa')
  })

  it('stacks on remaining time', async () => {
    await friend()
    await grantFriendLikeDays(her.id)
    await friend(); await friend()
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(21)
  })

  it('restarts from now when the old unlock is over', async () => {
    await sql`update users set likes_unlocked_until = now() - interval '30 days' where id = ${her.id}`
    await friend()
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(7)
  })

  it.each([
    ['a man', { gender: 'man' }, true],
    ['an unfinished signup', {}, false],
    ['a banned friend', { banned_at: '2026-01-01T00:00:00Z' }, true],
    ['a paused friend', { paused_at: '2026-01-01T00:00:00Z' }, true],
    ['a suspended friend', { suspended_until: '2099-01-01T00:00:00Z' }, true],
    ['a deleted friend', { deleted_at: '2026-01-01T00:00:00Z' }, true],
  ])('does not count %s', async (_n, extra, qualified) => {
    await friend(extra, qualified)
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(0)
  })

  it('does nothing while the referral program is off, then catches up', async () => {
    await sql`update referral_config set enabled = false`
    await friend()
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(0)
    await sql`update referral_config set enabled = true`
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(7)
  })

  it('a man inviting a woman gets no like days and the friend stays unpaid', async () => {
    const him = await createUser({ gender: 'man' })
    await friend({}, true, him)
    await grantFriendLikeDays(him.id)
    expect((await sql`select likes_unlocked_until from users where id = ${him.id}`)[0].likes_unlocked_until).toBeNull()
    expect((await sql`select likes_rewarded_at from referrals`)[0].likes_rewarded_at).toBeNull()
  })

  it("waits for the friend's photo check, and refuses a photo of a man", async () => {
    process.env.DEEPSEEK_API_KEY = 'x'
    const ok = await friend()
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(0)
    await insertRow('photo_ai_checks', { photo_id: ok.photoId, user_id: ok.id, approved: true, apparent_gender: 'woman' })
    await grantAfterPhotoCheck(ok.id)
    expect(await daysLeft()).toBe(7)

    const fake = await friend()
    await insertRow('photo_ai_checks', { photo_id: fake.photoId, user_id: fake.id, approved: true, apparent_gender: 'man' })
    await grantAfterPhotoCheck(fake.id)
    expect(await daysLeft()).toBe(7)
    await sql`update users set gender_review_dismissed_at = now() + interval '1 second' where id = ${fake.id}`
    await grantAfterPhotoCheck(fake.id)
    expect(await daysLeft()).toBe(14)
  })

  it('counts a friend whose check never answered after the grace time', async () => {
    process.env.DEEPSEEK_API_KEY = 'x'
    const f = await friend()
    await sql`update referrals set qualified_at = now() - interval '11 minutes' where referred_id = ${f.id}`
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(0) // her photo is still fresh
    await sql`update user_photos set created_at = now() - interval '11 minutes' where user_id = ${f.id}`
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(7)
  })

  it('does not count a friend without a photo', async () => {
    const f = await friend()
    await sql`delete from user_photos where user_id = ${f.id}`
    await grantFriendLikeDays(her.id)
    expect(await daysLeft()).toBe(0)
  })
})

describe('signup paths', () => {
  it("a woman's friend qualifying pays like days, not milestones", async () => {
    const f = await friend({}, false)
    await maybeQualifyReferral(f.id)
    expect(await daysLeft()).toBe(7)
    expect(await sql`select 1 from referral_rewards`).toHaveLength(0)
    expect(bot.notifyLikesUnlocked).toHaveBeenCalledTimes(1)
    expect(bot.notifyReferralQualified).not.toHaveBeenCalled()
    expect((await sql`select bonus_swipes from users where id = ${her.id}`)[0].bonus_swipes).toBe(0)
  })

  async function askLinkClaimedBy(tgId: number) {
    const target = await createUser()
    const ask = await insertRow('ask_requests', {
      requester_id: her.id, target_id: target.id, question: 'reply', expires_at: new Date(Date.now() + DAY).toISOString(),
    })
    await insertRow('ask_recipients', { request_id: ask.id, kind: 'link', advisor_tg_id: tgId })
  }

  it('a friend who joins through an ask link counts', async () => {
    await askLinkClaimedBy(777)
    const f = await createUser({ gender: 'woman', telegram_id: 777 })
    await createPhoto(f.id, 0)
    await captureAskAttribution(f.id, 777)
    await maybeQualifyReferral(f.id)
    expect(await daysLeft()).toBe(7)
  })

  it('an invite link keeps the credit over an ask link', async () => {
    const other = await createUser({ gender: 'woman' })
    await askLinkClaimedBy(778)
    const f = await createUser({ gender: 'woman', telegram_id: 778, referred_by: other.id })
    await sql`insert into referrals (referrer_id, referred_id) values (${other.id}, ${f.id})`
    await captureAskAttribution(f.id, 778)
    const rows = await sql`select referrer_id from referrals where referred_id = ${f.id}`
    expect(rows.map((r) => r.referrer_id)).toEqual([other.id])
  })
})

describe('GET /likes for a woman', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { app = await buildApp() })
  const get = async (url = '/likes') => {
    const res = await app.inject({ method: 'GET', url, headers: AUTH })
    expect(res.statusCode).toBe(200)
    return res
  }

  it('shows one like and only a count + opaque tiles for the rest', async () => {
    for (let i = 0; i < 9; i++) await addLiker()
    await addLiker({ is_seed: true }); await addLiker({}, 0) // never teased
    expect((await get('/likes/unread-count')).json().count).toBe(1)
    const res = await get()
    const body = res.json()
    expect(body.visible).toHaveLength(1)
    expect(body.queue).toMatchObject({ lockedCount: 8, inviteEnabled: true, premiumEnabled: false, daysPerFriend: 7 })
    expect(body.queue.photos).toHaveLength(6)
    expect(body.unlockedUntil).toBeNull()
    for (const id of likers.filter((id) => id !== body.visible[0].id)) {
      expect(res.body).not.toContain(id)
      for (const url of body.queue.photos) {
        expect(Buffer.from(url.split('/').pop(), 'base64url').toString('latin1')).not.toContain(id)
      }
    }
    expect(await hiddenIncomingLikerIds(her.id)).toHaveLength(10)
  })

  it('hides the section when there is no way to unlock', async () => {
    await sql`update referral_config set enabled = false`
    await addLiker(); await addLiker()
    expect((await get()).json().queue).toBeNull()
  })

  it.each([
    ['invite unlock', 'likes_unlocked_until'],
    ['premium', 'premium_until'],
  ])('%s opens everyone, in Discovery too', async (_n, col) => {
    for (let i = 0; i < 4; i++) await addLiker()
    await sql`update users set ${sql({ [col]: new Date(Date.now() + DAY).toISOString() })} where id = ${her.id}`
    const body = (await get()).json()
    expect(body.visible).toHaveLength(4)
    expect(body.queue).toBeNull()
    expect(body.unlockedUntil === null).toBe(col === 'premium_until')
    expect(await hiddenIncomingLikerIds(her.id)).toEqual([])
    expect(await sql`select 1 from like_reveals`).toHaveLength(0)
  })

  it('locks again when the unlock ends', async () => {
    for (let i = 0; i < 4; i++) await addLiker()
    await sql`update users set likes_unlocked_until = now() - interval '1 minute' where id = ${her.id}`
    const body = (await get()).json()
    expect(body.visible).toHaveLength(1)
    expect(body.queue.lockedCount).toBe(3)
  })

  it('men get no queue', async () => {
    authAs(await createUser({ gender: 'man' }))
    const body = (await get()).json()
    expect(body.queue).toBeNull()
    expect(body.unlockedUntil).toBeNull()
  })

  it('a friend who became countable unlocks on open', async () => {
    for (let i = 0; i < 3; i++) await addLiker()
    await friend()
    expect((await get()).json().visible).toHaveLength(3)
  })

  it('/referrals/me gives women the likes reward instead of milestones', async () => {
    await friend()
    const body = (await get('/referrals/me')).json()
    expect(body.milestones).toEqual([])
    expect(body.likesReward).toMatchObject({ daysPerFriend: 7, friendsCounted: 1 })
    expect(body.likesReward.unlockedUntil).toEqual(expect.any(String))
  })
})

describe('GET /likes/blurred/:token', () => {
  it('serves a tiny jpeg without auth; forged and expired tokens are 404', async () => {
    process.env.MEDIA_DIR = await mkdtemp(join(tmpdir(), 'luma-blur-'))
    const original = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#c33' } }).jpeg().toBuffer()
    await upload('profile-photos', 'u1/p1', original)
    const app = await buildApp()
    const exp = Math.floor(Date.now() / 1000) + 600
    const at = (token: string) => app.inject({ method: 'GET', url: `/likes/blurred/${token}` })

    const ok = await at(encodeBlurToken('u1/p1', exp))
    expect(ok.statusCode).toBe(200)
    const meta = await sharp(ok.rawPayload).metadata()
    expect([meta.width, meta.height]).toEqual([30, 40])

    const token = encodeBlurToken('u1/p1', exp)
    expect((await at(`${token.slice(0, -3)}AAA`)).statusCode).toBe(404)
    expect((await at(encodeBlurToken('u1/p1', exp - 4000))).statusCode).toBe(404)
    expect((await at(encodeBlurToken('u1/none', exp))).statusCode).toBe(404)
    expect(decodeBlurToken('garbage')).toBeNull()
  })
})
