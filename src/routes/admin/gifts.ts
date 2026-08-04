import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { getBotStarBalance } from '../../bot.js'

const PAGE_SIZE = 25
const TX_STATUSES = ['pending_payment', 'paid', 'sent', 'send_failed', 'refunded']
const TX_CONTEXTS = ['chat', 'discovery']

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

export async function adminGiftsRoutes(app: FastifyInstance) {
  app.get('/gifts/config', async (_req, reply) => {
    const { data, error } = await db
      .from('gift_config')
      .select('markup_percent, low_balance_threshold')
      .eq('id', true)
      .single()
    if (error || !data) return reply.status(500).send({ error: 'config_fetch_failed' })

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

    const { data, error } = await db
      .from('gift_config')
      .update(update)
      .eq('id', true)
      .select('markup_percent, low_balance_threshold')
      .single()
    if (error || !data) return reply.status(500).send({ error: 'config_update_failed' })

    return { markupPercent: data.markup_percent, lowBalanceThreshold: data.low_balance_threshold }
  })

  app.get('/gifts/balance', async (req, reply) => {
    const { data: config } = await db
      .from('gift_config')
      .select('low_balance_threshold')
      .eq('id', true)
      .single()
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

    let q = db
      .from('gift_transactions')
      .select(
        'id, gift_emoji, gift_star_cost, charged_stars, markup_stars, status, context, intro_status, created_at, ' +
        'buyer:users!gift_transactions_buyer_id_fkey(name), recipient:users!gift_transactions_recipient_id_fkey(name)',
        { count: 'exact' },
      )
    if (status && TX_STATUSES.includes(status)) q = q.eq('status', status)
    if (context && TX_CONTEXTS.includes(context)) q = q.eq('context', context)

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'transactions_fetch_failed' })

    const total = count ?? 0
    return {
      items: (data ?? []).map((r: any) => ({
        id: r.id,
        buyerName: r.buyer?.name ?? '',
        recipientName: r.recipient?.name ?? '',
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
