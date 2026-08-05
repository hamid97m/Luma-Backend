import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

const PLAN_SELECT = 'id, title, description, price_stars, discount_percent, duration_days, is_active, sort_order, created_at'

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
}
