import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const botUsername = vi.hoisted(() => ({ value: 'luma_bot' as string | null }))
vi.mock('../src/bot.js', () => ({ getBotUsername: () => botUsername.value }))

import { buildApp } from '../src/server.js'
import { resetDb, createUser, createPhoto, insertRow } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { clearFailures, failReadsOf } from './helpers/bot-support.js'

let nextTelegramId = 1
const seen = (tag: string, existing_user = false) =>
  insertRow('join_tag_starts', { tag, telegram_id: nextTelegramId++, existing_user })

/** A finished signup: real age + one photo. */
async function completedUser(tag: string, overrides: Record<string, unknown> = {}) {
  const u = await createUser({ join_tag: tag, ...overrides })
  await createPhoto(u.id)
  return u
}

const premiumTx = (user_id: string, overrides: Record<string, unknown> = {}) => insertRow('premium_transactions', {
  user_id, plan_title: 'Plan', price_stars: 100, duration_days: 30, status: 'paid', source: 'purchase',
  paid_at: new Date().toISOString(), ...overrides,
})

const giftTx = (buyer_id: string, recipient_id: string, overrides: Record<string, unknown> = {}) => insertRow('gift_transactions', {
  buyer_id, recipient_id, context: 'chat', gift_id: 'g1', gift_star_cost: 15, charged_stars: 20, status: 'sent', ...overrides,
})

describe('admin join tags', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  const get = async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/join-tags', headers })
    expect(res.statusCode).toBe(200)
    return res.json() as { items: Record<string, any>[]; botUsername: string | null }
  }
  const statsOf = async (tag: string) => (await get()).items.find((t) => t.tag === tag)!

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    botUsername.value = 'luma_bot'
    app = await buildApp()
    headers = adminHeaders()
  })
  afterEach(clearFailures)

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/join-tags' })
    expect(res.statusCode).toBe(401)
  })

  it('is read-only', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/admin/join-tags', headers })
      expect(res.statusCode).toBe(404)
    }
  })

  it('is empty until someone opens a tagged link', async () => {
    expect(await get()).toEqual({ items: [], botUsername: 'luma_bot' })
  })

  it('still answers when the bot username is unknown', async () => {
    await seen('insta')
    botUsername.value = null
    const body = await get()
    expect(body.botUsername).toBeNull()
    expect(body.items.map((t) => t.tag)).toEqual(['insta'])
  })

  it('shows a tag from its first /start, with zeros for the rest', async () => {
    await seen('insta')
    expect((await get()).items).toEqual([{
      tag: 'insta', opened: 1, signups: 0, completed: 0, men: 0, women: 0,
      active7d: 0, payingUsers: 0, starsEarned: 0, tomanEarned: 0,
    }])
  })

  it('sorts by signups, most first', async () => {
    for (const t of ['few', 'many', 'none-yet']) await seen(t)
    await createUser({ join_tag: 'few' })
    await createUser({ join_tag: 'many' })
    await createUser({ join_tag: 'many' })
    expect((await get()).items.map((t) => t.tag)).toEqual(['many', 'few', 'none-yet'])
  })

  it('opened counts only people who had no account', async () => {
    await seen('insta')
    await seen('insta')
    await seen('insta', true)
    await seen('other', true)
    expect((await statsOf('insta')).opened).toBe(2)
    expect((await statsOf('other')).opened).toBe(0)
  })

  it('gender counts ignore incomplete users', async () => {
    await seen('insta')
    await completedUser('insta', { gender: 'man' })
    await completedUser('insta', { gender: 'woman' })
    await completedUser('insta', { gender: 'woman' })
    await completedUser('insta', { gender: 'nonbinary' })
    // Abandoned at the first step: placeholder age 0 + gender 'man', no photo.
    await createUser({ join_tag: 'insta', age: 0, gender: 'man' })
    await createUser({ join_tag: 'insta', age: 0, gender: 'man' })
    // Age set but no photo; photo but no age.
    await createUser({ join_tag: 'insta', gender: 'woman' })
    await completedUser('insta', { age: 0, gender: 'man' })

    expect(await statsOf('insta')).toMatchObject({ signups: 8, completed: 4, men: 1, women: 2 })
  })

  it('counts a user once however many photos they have', async () => {
    await seen('insta')
    const u = await completedUser('insta', { gender: 'woman' })
    await createPhoto(u.id, 1)
    await createPhoto(u.id, 2)
    expect(await statsOf('insta')).toMatchObject({ signups: 1, completed: 1, women: 1 })
  })

  it('active7d needs activity at least 7 days after signup', async () => {
    await seen('insta')
    const created_at = '2026-01-01T00:00:00Z'
    await createUser({ join_tag: 'insta', created_at, last_active: '2026-01-08T00:00:00Z' })
    await createUser({ join_tag: 'insta', created_at, last_active: '2026-03-01T00:00:00Z' })
    await createUser({ join_tag: 'insta', created_at, last_active: '2026-01-07T23:59:59Z' })
    await createUser({ join_tag: 'insta', created_at, last_active: null })
    expect((await statsOf('insta')).active7d).toBe(2)
  })

  it('counts real payments from premium and gifts without double counting the buyer', async () => {
    await seen('insta')
    const buyer = await completedUser('insta')
    const other = await createUser()
    await premiumTx(buyer.id, { price_stars: 100 })
    await premiumTx(buyer.id, { price_stars: 250 })
    await giftTx(buyer.id, other.id, { charged_stars: 20, status: 'sent' })
    await giftTx(buyer.id, other.id, { charged_stars: 30, status: 'paid' })
    // Multiple photos must not multiply the money.
    await createPhoto(buyer.id, 1)
    expect(await statsOf('insta')).toMatchObject({ payingUsers: 1, starsEarned: 400, signups: 1 })
  })

  it('stats exclude admin grants, referral rewards and unfinished payments', async () => {
    await seen('insta')
    const u = await completedUser('insta')
    const other = await createUser()
    await premiumTx(u.id, { price_stars: 0, source: 'admin_grant' })
    await premiumTx(u.id, { price_stars: 0, source: 'referral' })
    await premiumTx(u.id, { status: 'pending_payment', paid_at: null })
    await premiumTx(u.id, { status: 'canceled', paid_at: null })
    await premiumTx(u.id, { status: 'refunded' })
    await giftTx(u.id, other.id, { status: 'pending_payment' })
    await giftTx(u.id, other.id, { status: 'refunded' })
    await giftTx(u.id, other.id, { status: 'send_failed' })
    expect(await statsOf('insta')).toMatchObject({ payingUsers: 0, starsEarned: 0 })
  })

  it('a gift received is not a payment by the recipient', async () => {
    await seen('insta')
    const recipient = await completedUser('insta')
    const buyer = await createUser()
    await giftTx(buyer.id, recipient.id)
    expect((await statsOf('insta')).payingUsers).toBe(0)
  })

  it('reports Toman separately: a paying user, but not Stars', async () => {
    await seen('insta')
    const toman = await completedUser('insta')
    const fallback = await completedUser('insta')
    const unfinished = await completedUser('insta')
    await premiumTx(toman.id, { provider: 'tonpays', price_stars: 100, price_toman: 500_000, tonpays_final_amount: 500_123 })
    await premiumTx(fallback.id, { provider: 'tonpays', price_stars: 100, price_toman: 400_000 })
    await premiumTx(unfinished.id, { provider: 'tonpays', status: 'paid_grant_failed', price_toman: 900_000 })
    expect(await statsOf('insta')).toMatchObject({ payingUsers: 2, starsEarned: 0, tomanEarned: 900_123 })
  })

  it('keeps each tag separate and ignores users with no tag', async () => {
    await seen('a')
    await seen('b')
    await premiumTx((await completedUser('a')).id, { price_stars: 10 })
    await premiumTx((await completedUser('b')).id, { price_stars: 20 })
    await premiumTx((await createUser()).id, { price_stars: 40 })
    expect(await statsOf('a')).toMatchObject({ signups: 1, starsEarned: 10 })
    expect(await statsOf('b')).toMatchObject({ signups: 1, starsEarned: 20 })
  })

  it('500 join_tags_fetch_failed when a query errors', async () => {
    await failReadsOf('join_tag_starts')
    const res = await app.inject({ method: 'GET', url: '/admin/join-tags', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'join_tags_fetch_failed' })
  })

  describe('admin users', () => {
    const users = async (query = '') => {
      const res = await app.inject({ method: 'GET', url: `/admin/users${query}`, headers })
      expect(res.statusCode).toBe(200)
      return res.json()
    }
    const names = (body: { items: { name: string }[] }) => body.items.map((u) => u.name).sort()

    it('list includes each user\'s tag', async () => {
      await createUser({ name: 'Tagged', join_tag: 'insta' })
      await createUser({ name: 'Organic' })
      const { items } = await users()
      expect(Object.fromEntries(items.map((u: any) => [u.name, u.joinTag]))).toEqual({ Tagged: 'insta', Organic: null })
    })

    it('filters by tag, including the total', async () => {
      await createUser({ name: 'A', join_tag: 'a' })
      await createUser({ name: 'B', join_tag: 'b' })
      await createUser({ name: 'None' })
      const body = await users('?tag=a')
      expect(names(body)).toEqual(['A'])
      expect(body.total).toBe(1)
    })

    it('the tag filter is case-insensitive', async () => {
      await createUser({ name: 'A', join_tag: 'insta' })
      expect(names(await users('?tag=INSTA'))).toEqual(['A'])
    })

    it('filters by none', async () => {
      await createUser({ name: 'A', join_tag: 'a' })
      await createUser({ name: 'None' })
      const body = await users('?tag=none')
      expect(names(body)).toEqual(['None'])
      expect(body.total).toBe(1)
    })

    it('no filter returns everyone, and an unseen tag returns nobody', async () => {
      await createUser({ name: 'A', join_tag: 'a' })
      await createUser({ name: 'None' })
      expect(names(await users())).toEqual(['A', 'None'])
      expect(names(await users('?tag='))).toEqual(['A', 'None'])
      expect(names(await users('?tag=unseen'))).toEqual([])
    })

    it('combines with search', async () => {
      await createUser({ name: 'Sara', join_tag: 'a' })
      await createUser({ name: 'Ali', join_tag: 'a' })
      expect(names(await users('?tag=a&query=sara'))).toEqual(['Sara'])
    })

    it('detail includes the tag and referred_by', async () => {
      const referrer = await createUser()
      const u = await createUser({ join_tag: 'insta', referred_by: referrer.id })
      const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })
      expect(res.statusCode).toBe(200)
      expect(res.json().user).toMatchObject({ joinTag: 'insta', referredBy: referrer.id })
    })

    it('detail shows nulls for an organic user', async () => {
      const u = await createUser()
      const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })
      expect(res.json().user).toMatchObject({ joinTag: null, referredBy: null })
    })
  })
})
