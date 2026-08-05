import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { extendPremiumUntil } from '../../premium/service.js'

const PLAN_SELECT = 'id, title, description, price_stars, discount_percent, duration_days, is_active, sort_order, created_at'
const PAGE_SIZE = 25
const TX_STATUSES = ['pending_payment', 'paid', 'refunded']
const TX_SOURCES = ['purchase', 'admin_grant']

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

function planToJson(p: any) {
  return {
    id: p.id, title: p.title, description: p.description,
    priceStars: p.price_stars, discountPercent: p.discount_percent ?? null,
    durationDays: p.duration_days, isActive: p.is_active, sortOrder: p.sort_order,
    createdAt: p.created_at,
  }
}

/** Validate + map camelCase plan fields to a snake_case row. `partial` allows omitted fields (PUT). */
function parsePlanBody(body: Record<string, unknown>, partial: boolean): { error: string } | { row: Record<string, unknown> } {
  const row: Record<string, unknown> = {}
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) return { error: 'invalid_title' }
    row.title = body.title.trim()
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { error: 'invalid_description' }
    row.description = body.description
  }
  if (body.priceStars !== undefined || !partial) {
    if (!isPositiveInt(body.priceStars)) return { error: 'invalid_price_stars' }
    row.price_stars = body.priceStars
  }
  if (body.durationDays !== undefined || !partial) {
    if (!isPositiveInt(body.durationDays)) return { error: 'invalid_duration_days' }
    row.duration_days = body.durationDays
  }
  if (body.discountPercent !== undefined) {
    if (body.discountPercent !== null && (!isPositiveInt(body.discountPercent) || (body.discountPercent as number) > 90)) {
      return { error: 'invalid_discount_percent' }
    }
    row.discount_percent = body.discountPercent
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'invalid_is_active' }
    row.is_active = body.isActive
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) return { error: 'invalid_sort_order' }
    row.sort_order = body.sortOrder
  }
  return { row }
}

export async function adminPremiumRoutes(app: FastifyInstance) {
  app.get('/premium/config', async (_req, reply) => {
    const { data, error } = await db.from('premium_config').select('premium_enabled').eq('id', true).single()
    if (error || !data) return reply.status(500).send({ error: 'config_fetch_failed' })
    return { premiumEnabled: data.premium_enabled }
  })

  app.put('/premium/config', async (req, reply) => {
    const { premiumEnabled } = (req.body ?? {}) as Record<string, unknown>
    if (typeof premiumEnabled !== 'boolean') return reply.status(400).send({ error: 'invalid_premium_enabled' })
    const { data, error } = await db
      .from('premium_config')
      .update({ premium_enabled: premiumEnabled, updated_at: new Date().toISOString() })
      .eq('id', true).select('premium_enabled').single()
    if (error || !data) return reply.status(500).send({ error: 'config_update_failed' })
    return { premiumEnabled: data.premium_enabled }
  })

  app.get('/premium/plans', async (_req, reply) => {
    const { data, error } = await db
      .from('premium_plans').select(PLAN_SELECT)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return reply.status(500).send({ error: 'plans_fetch_failed' })
    return { plans: (data ?? []).map(planToJson) }
  })

  app.post('/premium/plans', async (req, reply) => {
    const parsed = parsePlanBody((req.body ?? {}) as Record<string, unknown>, false)
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    const { data, error } = await db.from('premium_plans').insert(parsed.row).select(PLAN_SELECT).single()
    if (error || !data) return reply.status(500).send({ error: 'plan_create_failed' })
    return reply.status(201).send(planToJson(data))
  })

  app.put('/premium/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = parsePlanBody((req.body ?? {}) as Record<string, unknown>, true)
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    if (Object.keys(parsed.row).length === 0) return reply.status(400).send({ error: 'empty_update' })
    parsed.row.updated_at = new Date().toISOString()
    const { data, error } = await db
      .from('premium_plans').update(parsed.row).eq('id', id).select(PLAN_SELECT).maybeSingle()
    if (error) return reply.status(500).send({ error: 'plan_update_failed' })
    if (!data) return reply.status(404).send({ error: 'plan_not_found' })
    return planToJson(data)
  })

  app.delete('/premium/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { count, error: countErr } = await db
      .from('premium_transactions').select('id', { count: 'exact', head: true }).eq('plan_id', id)
    if (countErr) return reply.status(500).send({ error: 'plan_delete_failed' })
    if ((count ?? 0) > 0) return reply.status(409).send({ error: 'plan_has_transactions' })
    const { data, error } = await db.from('premium_plans').delete().eq('id', id).select('id').maybeSingle()
    if (error) return reply.status(500).send({ error: 'plan_delete_failed' })
    if (!data) return reply.status(404).send({ error: 'plan_not_found' })
    return { ok: true }
  })

  app.get('/premium/transactions', async (req, reply) => {
    const { page = '1', status, source } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    let q = db
      .from('premium_transactions')
      .select(
        'id, plan_title, price_stars, duration_days, status, source, created_at, paid_at, ' +
        'user:users!premium_transactions_user_id_fkey(name, username)',
        { count: 'exact' },
      )
    if (status && TX_STATUSES.includes(status)) q = q.eq('status', status)
    if (source && TX_SOURCES.includes(source)) q = q.eq('source', source)

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return reply.status(500).send({ error: 'transactions_fetch_failed' })

    const total = count ?? 0
    return {
      items: (data ?? []).map((r: any) => ({
        id: r.id,
        userName: r.user?.name ?? '',
        userUsername: r.user?.username ?? null,
        planTitle: r.plan_title,
        priceStars: r.price_stars,
        durationDays: r.duration_days,
        status: r.status,
        source: r.source,
        createdAt: r.created_at,
        paidAt: r.paid_at ?? null,
      })),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })

  app.post('/users/:id/premium/grant', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { days } = (req.body ?? {}) as { days?: unknown }
    if (!isPositiveInt(days) || days > 3650) return reply.status(400).send({ error: 'invalid_days' })

    const { data: user } = await db.from('users').select('id, premium_until').eq('id', id).maybeSingle()
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    const premiumUntil = extendPremiumUntil(user.premium_until ?? null, days)
    const { error: updErr } = await db.from('users').update({ premium_until: premiumUntil }).eq('id', id)
    if (updErr) return reply.status(500).send({ error: 'grant_failed' })

    const { error: txErr } = await db.from('premium_transactions').insert({
      user_id: id, plan_id: null, plan_title: 'Admin grant', price_stars: 0,
      duration_days: days, status: 'paid', source: 'admin_grant', paid_at: new Date().toISOString(),
    })
    if (txErr) req.log.warn({ err: txErr }, 'failed to record admin grant tx')

    return { premiumUntil }
  })

  app.post('/users/:id/premium/revoke', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { data, error } = await db
      .from('users').update({ premium_until: null }).eq('id', id).select('id').maybeSingle()
    if (error) return reply.status(500).send({ error: 'revoke_failed' })
    if (!data) return reply.status(404).send({ error: 'user_not_found' })
    return { ok: true }
  })
}
