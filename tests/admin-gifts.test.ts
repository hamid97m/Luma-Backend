import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ getBotStarBalance: vi.fn() }))

import { buildApp } from '../src/server.js'
import { getBotStarBalance } from '../src/bot.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { createGiftTx, failWritesTo } from './helpers/gifts-referrals.js'

describe('admin gifts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let alice: Record<string, any>
  let bob: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    // The admin preHandler only verifies the JWT (no admins-table lookup).
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
    alice = await createUser({ name: 'Alice' })
    bob = await createUser({ name: 'Bob', gender: 'woman', looking_for: 'men' })
  })

  const list = (qs = '') => app.inject({ method: 'GET', url: `/admin/gifts/transactions${qs}`, headers })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the gift config', async () => {
    await sql`update gift_config set markup_percent = 33, low_balance_threshold = 500 where id = true`
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ markupPercent: 33, lowBalanceThreshold: 500 })
  })

  it('500 config_fetch_failed when the config row is missing', async () => {
    await sql`delete from gift_config`
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('updates the gift config and returns the new values', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/gifts/config', headers,
      payload: { markupPercent: 40, lowBalanceThreshold: 1000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ markupPercent: 40, lowBalanceThreshold: 1000 })
    const [row] = await sql`select markup_percent, low_balance_threshold from gift_config`
    expect(row).toEqual({ markup_percent: 40, low_balance_threshold: 1000 })
  })

  it('a partial update leaves the other field untouched', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/gifts/config', headers, payload: { markupPercent: 10 } })
    expect(res.json()).toEqual({ markupPercent: 10, lowBalanceThreshold: 500 })
  })

  it('500 config_update_failed when the write errors', async () => {
    const cleanup = await failWritesTo('gift_config', 'UPDATE')
    try {
      const res = await app.inject({ method: 'PUT', url: '/admin/gifts/config', headers, payload: { markupPercent: 10 } })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'config_update_failed' })
    } finally {
      await cleanup()
    }
  })

  it('rejects a negative markupPercent on update', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/gifts/config', headers, payload: { markupPercent: -5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_markup_percent' })
  })

  it('flags low balance when below the configured threshold', async () => {
    vi.mocked(getBotStarBalance).mockResolvedValue(100)
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/balance', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: 100, lowBalanceThreshold: 500, low: true })
  })

  it('returns balance: null without erroring when the Telegram call fails', async () => {
    vi.mocked(getBotStarBalance).mockRejectedValue(new Error('telegram down'))
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/balance', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: null, lowBalanceThreshold: 500, low: false })
  })

  it('treats a missing config row as threshold 0 on /balance', async () => {
    await sql`delete from gift_config`
    vi.mocked(getBotStarBalance).mockResolvedValue(100)
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/balance', headers })
    expect(res.json()).toEqual({ balance: 100, lowBalanceThreshold: 0, low: false })
  })

  it('lists recent gift transactions with buyer/recipient names', async () => {
    const tx = await createGiftTx(alice.id, bob.id, {
      context: 'chat', status: 'sent', created_at: '2026-10-01T10:00:00Z',
    })
    const res = await list()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        id: tx.id, buyerName: 'Alice', recipientName: 'Bob', emoji: '🌹',
        giftStarCost: 15, chargedStars: 20, markupStars: 5,
        status: 'sent', context: 'chat', introStatus: null, createdAt: '2026-10-01T10:00:00.000Z',
      }],
      total: 1, page: 1, pageCount: 1,
    })
  })

  it('orders newest first', async () => {
    const a = await createGiftTx(alice.id, bob.id, { created_at: '2026-10-01T00:00:00Z' })
    const b = await createGiftTx(alice.id, bob.id, { created_at: '2026-10-03T00:00:00Z' })
    const c = await createGiftTx(alice.id, bob.id, { created_at: '2026-10-02T00:00:00Z' })
    expect((await list()).json().items.map((i: any) => i.id)).toEqual([b.id, c.id, a.id])
  })

  describe('filters', () => {
    beforeEach(async () => {
      await createGiftTx(alice.id, bob.id, { status: 'paid', context: 'chat' })
      await createGiftTx(alice.id, bob.id, { status: 'paid', context: 'discovery' })
      await createGiftTx(alice.id, bob.id, { status: 'sent', context: 'discovery' })
    })

    it('applies a status filter', async () => {
      const body = (await list('?status=paid')).json()
      expect(body.total).toBe(2)
      expect(body.items.every((i: any) => i.status === 'paid')).toBe(true)
    })

    it('applies a context filter', async () => {
      const body = (await list('?context=discovery')).json()
      expect(body.total).toBe(2)
      expect(body.items.every((i: any) => i.context === 'discovery')).toBe(true)
    })

    it('combines status and context filters', async () => {
      const body = (await list('?status=paid&context=discovery')).json()
      expect(body.total).toBe(1)
      expect(body.items).toHaveLength(1)
    })

    it('ignores invalid status/context values instead of filtering or erroring', async () => {
      const res = await list('?status=bogus&context=nowhere')
      expect(res.statusCode).toBe(200)
      expect(res.json().total).toBe(3)
    })

    it('applies status=all/context=all as no filter', async () => {
      const res = await list('?status=all&context=all')
      expect(res.statusCode).toBe(200)
      expect(res.json().total).toBe(3)
    })
  })

  it('paginates: computes pageCount from total, echoes the page, and slices 25 per page', async () => {
    const rows = Array.from({ length: 53 }, (_, i) => ({
      buyer_id: alice.id, recipient_id: bob.id, context: 'discovery', gift_id: 'g',
      gift_star_cost: 15, charged_stars: 20,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }))
    await sql`insert into gift_transactions ${sql(rows)}`

    const p3 = (await list('?page=3')).json()
    expect(p3.total).toBe(53)
    expect(p3.page).toBe(3)
    expect(p3.pageCount).toBe(3) // ceil(53 / 25)
    expect(p3.items).toHaveLength(3)

    // Page 2 = rows 25..49 of the newest-first list.
    const p2 = (await list('?page=2')).json()
    expect(p2.items).toHaveLength(25)
    expect(p2.items[0].createdAt).toBe(rows[52 - 25].created_at)
    expect(p2.items[24].createdAt).toBe(rows[52 - 49].created_at)
  })

  it('returns 500 transactions_fetch_failed when the query errors', async () => {
    await sql`alter table gift_transactions rename column gift_emoji to gift_emoji_x`
    try {
      const res = await list()
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'transactions_fetch_failed' })
    } finally {
      await sql`alter table gift_transactions rename column gift_emoji_x to gift_emoji`
    }
  })
})
