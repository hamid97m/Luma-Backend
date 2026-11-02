import { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
import { getBotStarBalance } from '../../bot.js'

const PAGE_SIZE = 25
const TX_STATUSES = ['pending_payment', 'paid', 'sent', 'send_failed', 'refunded']
const TX_CONTEXTS = ['chat', 'discovery']

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

export async function adminGiftsRoutes(app: FastifyInstance) {
  app.get('/gifts/config', async (req, reply) => {
    let data: { markup_percent: number; low_balance_threshold: number } | undefined
    try {
      ;[data] = await sql<{ markup_percent: number; low_balance_threshold: number }[]>`
        select markup_percent, low_balance_threshold from gift_config where id = true`
    } catch (err) {
      req.log.error({ err }, 'gift config fetch failed')
    }
    if (!data) return reply.status(500).send({ error: 'config_fetch_failed' })

    return { markupPercent: data.markup_percent, lowBalanceThreshold: data.low_balance_threshold }
  })

  app.put('/gifts/config', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const update: Record<string, unknown> = {}

    if (body.markupPercent !== undefined) {
      if (!isNonNegativeInt(body.markupPercent)) {
        return reply.status(400).send({ error: 'invalid_markup_percent' })
      }
      update.markup_percent = body.markupPercent
    }
    if (body.lowBalanceThreshold !== undefined) {
      if (!isNonNegativeInt(body.lowBalanceThreshold)) {
        return reply.status(400).send({ error: 'invalid_low_balance_threshold' })
      }
      update.low_balance_threshold = body.lowBalanceThreshold
    }

    update.updated_at = new Date().toISOString()

    let data: { markup_percent: number; low_balance_threshold: number } | undefined
    try {
      ;[data] = await sql<{ markup_percent: number; low_balance_threshold: number }[]>`
        update gift_config set ${sql(update)} where id = true
        returning markup_percent, low_balance_threshold`
    } catch (err) {
      req.log.error({ err }, 'gift config update failed')
    }
    if (!data) return reply.status(500).send({ error: 'config_update_failed' })

    return { markupPercent: data.markup_percent, lowBalanceThreshold: data.low_balance_threshold }
  })

  app.get('/gifts/balance', async (req, reply) => {
    // A failed read was tolerated before (threshold falls back to 0).
    const [config] = await sql<{ low_balance_threshold: number }[]>`
      select low_balance_threshold from gift_config where id = true`.catch(() => [])
    const lowBalanceThreshold = config?.low_balance_threshold ?? 0

    try {
      const balance = await getBotStarBalance()
      return { balance, lowBalanceThreshold, low: balance < lowBalanceThreshold }
    } catch (err) {
      req.log.warn({ err }, 'failed to fetch bot star balance')
      return { balance: null, lowBalanceThreshold, low: false }
    }
  })

  app.get('/gifts/transactions', async (req, reply) => {
    const { page = '1', status, context } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    // Unknown filter values (incl. 'all') are ignored, not rejected.
    const where = sql`
      where true
      ${status && TX_STATUSES.includes(status) ? sql`and t.status = ${status}` : sql``}
      ${context && TX_CONTEXTS.includes(context) ? sql`and t.context = ${context}` : sql``}`

    let data: Record<string, any>[]
    let total: number
    try {
      const [rows, [{ count }]] = await Promise.all([
        sql`
          select t.id, t.gift_emoji, t.gift_star_cost, t.charged_stars, t.markup_stars, t.status,
            t.context, t.intro_status, t.created_at, b.name as buyer_name, r.name as recipient_name
          from gift_transactions t
          left join users b on b.id = t.buyer_id
          left join users r on r.id = t.recipient_id
          ${where}
          order by t.created_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from gift_transactions t ${where}`,
      ])
      data = rows
      total = count
    } catch (err) {
      req.log.error({ err }, 'gift transactions fetch failed')
      return reply.status(500).send({ error: 'transactions_fetch_failed' })
    }

    return {
      items: data.map((r: any) => ({
        id: r.id,
        buyerName: r.buyer_name ?? '',
        recipientName: r.recipient_name ?? '',
        emoji: r.gift_emoji,
        giftStarCost: r.gift_star_cost,
        chargedStars: r.charged_stars,
        markupStars: r.markup_stars,
        status: r.status,
        context: r.context,
        introStatus: r.intro_status,
        createdAt: r.created_at,
      })),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })
}
