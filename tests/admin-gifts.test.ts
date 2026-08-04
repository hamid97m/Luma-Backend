import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({ getBotStarBalance: vi.fn() }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { getBotStarBalance } from '../src/bot.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin gifts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/gifts/config' })
    expect(res.statusCode).toBe(401)
  })

  it('reads the gift config', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_config') {
        return chainable({ data: { markup_percent: 33, low_balance_threshold: 500 }, error: null })
      }
      return chainable({ data: null, error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/gifts/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ markupPercent: 33, lowBalanceThreshold: 500 })
  })

  it('updates the gift config and returns the new values', async () => {
    const configUpdate = vi.fn(() =>
      chainable({ data: { markup_percent: 40, low_balance_threshold: 1000 }, error: null }),
    )
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_config') return { update: configUpdate } as any
      return chainable({ data: null, error: null })
    })

    const res = await app.inject({
      method: 'PUT', url: '/admin/gifts/config', headers,
      payload: { markupPercent: 40, lowBalanceThreshold: 1000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ markupPercent: 40, lowBalanceThreshold: 1000 })
    expect((configUpdate.mock.calls[0][0] as any)).toMatchObject({
      markup_percent: 40, low_balance_threshold: 1000,
    })
  })

  it('rejects a negative markupPercent on update', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/gifts/config', headers, payload: { markupPercent: -5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_markup_percent' })
  })

  it('flags low balance when below the configured threshold', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_config') {
        return chainable({ data: { low_balance_threshold: 500 }, error: null })
      }
      return chainable({ data: null, error: null })
    })
    vi.mocked(getBotStarBalance).mockResolvedValue(100)

    const res = await app.inject({ method: 'GET', url: '/admin/gifts/balance', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: 100, lowBalanceThreshold: 500, low: true })
  })

  it('returns balance: null without erroring when the Telegram call fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_config') {
        return chainable({ data: { low_balance_threshold: 500 }, error: null })
      }
      return chainable({ data: null, error: null })
    })
    vi.mocked(getBotStarBalance).mockRejectedValue(new Error('telegram down'))

    const res = await app.inject({ method: 'GET', url: '/admin/gifts/balance', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: null, lowBalanceThreshold: 500, low: false })
  })

  it('lists recent gift transactions with buyer/recipient names', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') {
        return chainable({
          data: [{
            id: 'g1', gift_emoji: '🌹', gift_star_cost: 15, charged_stars: 20, markup_stars: 5,
            status: 'sent', context: 'chat', intro_status: null, created_at: 'now',
            buyer: { name: 'Alice' }, recipient: { name: 'Bob' },
          }],
          count: 1,
          error: null,
        })
      }
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/gifts/transactions', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        id: 'g1', buyerName: 'Alice', recipientName: 'Bob', emoji: '🌹',
        giftStarCost: 15, chargedStars: 20, markupStars: 5,
        status: 'sent', context: 'chat', introStatus: null, createdAt: 'now',
      }],
      total: 1, page: 1, pageCount: 1,
    })
  })

  it('applies a status filter as .eq("status", ...)', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 0, error: null }, log)
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?status=paid', headers,
    })
    expect(res.statusCode).toBe(200)
    expect(log.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'paid')).toBe(true)
    expect(log.some((c) => c.method === 'eq' && c.args[0] === 'context')).toBe(false)
  })

  it('applies a context filter as .eq("context", ...)', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 0, error: null }, log)
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?context=discovery', headers,
    })
    expect(res.statusCode).toBe(200)
    expect(log.some((c) => c.method === 'eq' && c.args[0] === 'context' && c.args[1] === 'discovery')).toBe(true)
    expect(log.some((c) => c.method === 'eq' && c.args[0] === 'status')).toBe(false)
  })

  it('ignores invalid status/context values instead of filtering or erroring', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 0, error: null }, log)
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?status=bogus&context=nowhere', headers,
    })
    expect(res.statusCode).toBe(200)
    expect(log.some((c) => c.method === 'eq')).toBe(false)
  })

  it('applies status=all/context=all as no filter', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 0, error: null }, log)
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?status=all&context=all', headers,
    })
    expect(res.statusCode).toBe(200)
    expect(log.some((c) => c.method === 'eq')).toBe(false)
  })

  it('paginates: computes pageCount from count and echoes the requested page', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 53, error: null })
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?page=3', headers,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(53)
    expect(body.page).toBe(3)
    expect(body.pageCount).toBe(3) // ceil(53 / 25)
  })

  it('uses .range(from, from + PAGE_SIZE - 1) for the requested page', async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: [], count: 0, error: null }, log)
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({
      method: 'GET', url: '/admin/gifts/transactions?page=2', headers,
    })
    expect(res.statusCode).toBe(200)
    expect(log.some((c) => c.method === 'range' && c.args[0] === 25 && c.args[1] === 49)).toBe(true)
  })

  it('defaults to page 1 with no total when the query errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'gift_transactions') return chainable({ data: null, count: null, error: { message: 'boom' } })
      return chainable({ data: [], count: 0, error: null })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/gifts/transactions', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'transactions_fetch_failed' })
  })
})
