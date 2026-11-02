import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../../db.js'
import { extendPremiumUntil, type PlanTranslations } from '../../premium/service.js'

const PLAN_COLS = [
  'id', 'title', 'description', 'translations', 'price_stars', 'discount_percent',
  'discount_ends_at', 'duration_days', 'is_active', 'sort_order', 'created_at',
]

/** Plan row for `sql(row)`: jsonb `translations` must be passed as json explicitly. */
function planRowForSql(row: Record<string, unknown>): Record<string, any> {
  return row.translations === undefined ? row : { ...row, translations: sql.json(row.translations as any) }
}
const PAGE_SIZE = 25
const TX_STATUSES = ['pending_payment', 'paid', 'refunded', 'canceled', 'paid_grant_failed']
const TX_SOURCES = ['purchase', 'admin_grant', 'referral']
const TX_PROVIDERS = ['stars', 'tonpays']
const TRANSLATABLE_LOCALES = ['en', 'ar'] as const

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

/** `{ en?: {title?, description?}, ar?: {...} }` with the same length caps as the base fields.
 * Persian lives in the base columns, so `fa` is not an accepted key. */
function parseTranslations(raw: unknown): { error: string } | { value: PlanTranslations } {
  if (raw === undefined || raw === null) return { value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_translations' }
  const out: PlanTranslations = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TRANSLATABLE_LOCALES as readonly string[]).includes(k)) return { error: 'invalid_translations' }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'invalid_translations' }
    const { title, description } = v as { title?: unknown; description?: unknown }
    const entry: { title?: string; description?: string } = {}
    if (title !== undefined) {
      if (typeof title !== 'string' || title.length > 32) return { error: 'invalid_translations' }
      if (title.trim()) entry.title = title.trim()
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 255) return { error: 'invalid_translations' }
      if (description.trim()) entry.description = description.trim()
    }
    // Blank strings fall back to Persian at read time anyway; don't persist them.
    if (Object.keys(entry).length) out[k as 'en' | 'ar'] = entry
  }
  return { value: out }
}

function planToJson(p: any) {
  return {
    id: p.id, title: p.title, description: p.description,
    translations: p.translations ?? {},
    priceStars: p.price_stars, discountPercent: p.discount_percent ?? null,
    discountEndsAt: p.discount_ends_at ?? null,
    durationDays: p.duration_days, isActive: p.is_active, sortOrder: p.sort_order,
    createdAt: p.created_at,
  }
}

/** Validate + map camelCase plan fields to a snake_case row. `partial` allows omitted fields (PUT). */
function parsePlanBody(body: Record<string, unknown>, partial: boolean): { error: string } | { row: Record<string, unknown> } {
  const row: Record<string, unknown> = {}
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) return { error: 'invalid_title' }
    const title = body.title.trim()
    // Telegram createInvoiceLink caps title at 32 chars; longer values 500 every checkout for the plan.
    if (title.length > 32) return { error: 'invalid_title' }
    row.title = title
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { error: 'invalid_description' }
    // Telegram createInvoiceLink caps description at 255 chars.
    if (body.description.length > 255) return { error: 'invalid_description' }
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
  if (body.discountEndsAt !== undefined) {
    if (body.discountEndsAt !== null) {
      if (typeof body.discountEndsAt !== 'string' || Number.isNaN(new Date(body.discountEndsAt).getTime())) {
        return { error: 'invalid_discount_ends_at' }
      }
      // A deadline needs a percent to apply to. On POST the percent must be given in this same
      // request; on PUT an omitted percent assumes the row's existing one — only an explicit null
      // (clearing it) conflicts with setting a deadline.
      const percentMissing = partial ? body.discountPercent === null : body.discountPercent === undefined || body.discountPercent === null
      if (percentMissing) return { error: 'discount_ends_requires_percent' }
    }
    row.discount_ends_at = body.discountEndsAt
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'invalid_is_active' }
    row.is_active = body.isActive
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) return { error: 'invalid_sort_order' }
    row.sort_order = body.sortOrder
  }
  if (body.translations !== undefined) {
    const tr = parseTranslations(body.translations)
    if ('error' in tr) return { error: tr.error }
    row.translations = tr.value
  }
  return { row }
}

export async function adminPremiumRoutes(app: FastifyInstance) {
  app.get('/premium/config', async (_req, reply) => {
    const [data] = await sql`select premium_enabled, toman_per_star from premium_config where id = true`
      .catch(() => [])
    if (!data) return reply.status(500).send({ error: 'config_fetch_failed' })
    return { premiumEnabled: data.premium_enabled, tomanPerStar: data.toman_per_star }
  })

  app.put('/premium/config', async (req, reply) => {
    const { premiumEnabled, tomanPerStar } = (req.body ?? {}) as Record<string, unknown>
    if (premiumEnabled === undefined && tomanPerStar === undefined) {
      return reply.status(400).send({ error: 'empty_update' })
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (premiumEnabled !== undefined) {
      if (typeof premiumEnabled !== 'boolean') return reply.status(400).send({ error: 'invalid_premium_enabled' })
      update.premium_enabled = premiumEnabled
    }
    if (tomanPerStar !== undefined) {
      if (!isPositiveInt(tomanPerStar)) return reply.status(400).send({ error: 'invalid_toman_per_star' })
      update.toman_per_star = tomanPerStar
    }
    const [data] = await sql`
      update premium_config set ${sql(update)} where id = true
      returning premium_enabled, toman_per_star`.catch(() => [])
    if (!data) return reply.status(500).send({ error: 'config_update_failed' })
    return { premiumEnabled: data.premium_enabled, tomanPerStar: data.toman_per_star }
  })

  app.get('/premium/plans', async (_req, reply) => {
    let data: any[]
    try {
      data = await sql`select ${sql(PLAN_COLS)} from premium_plans order by sort_order asc, created_at asc`
    } catch {
      return reply.status(500).send({ error: 'plans_fetch_failed' })
    }
    return { plans: data.map(planToJson) }
  })

  app.post('/premium/plans', async (req, reply) => {
    const parsed = parsePlanBody((req.body ?? {}) as Record<string, unknown>, false)
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    const [data] = await sql`
      insert into premium_plans ${sql(planRowForSql(parsed.row))} returning ${sql(PLAN_COLS)}`.catch(() => [])
    if (!data) return reply.status(500).send({ error: 'plan_create_failed' })
    return reply.status(201).send(planToJson(data))
  })

  app.put('/premium/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = parsePlanBody((req.body ?? {}) as Record<string, unknown>, true)
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
    if (Object.keys(parsed.row).length === 0) return reply.status(400).send({ error: 'empty_update' })
    parsed.row.updated_at = new Date().toISOString()
    // Malformed id can't be a plan → 404 rather than a uuid cast error.
    if (!isUuid(id)) return reply.status(404).send({ error: 'plan_not_found' })
    let data: any
    try {
      ;[data] = await sql`
        update premium_plans set ${sql(planRowForSql(parsed.row))} where id = ${id}
        returning ${sql(PLAN_COLS)}`
    } catch {
      return reply.status(500).send({ error: 'plan_update_failed' })
    }
    if (!data) return reply.status(404).send({ error: 'plan_not_found' })
    return planToJson(data)
  })

  app.delete('/premium/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'plan_not_found' })
    let data: any
    try {
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from premium_transactions where plan_id = ${id}`
      if (count > 0) return reply.status(409).send({ error: 'plan_has_transactions' })
      ;[data] = await sql`delete from premium_plans where id = ${id} returning id`
    } catch {
      return reply.status(500).send({ error: 'plan_delete_failed' })
    }
    if (!data) return reply.status(404).send({ error: 'plan_not_found' })
    return { ok: true }
  })

  app.get('/premium/transactions', async (req, reply) => {
    const { page = '1', status, source, provider } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    const where = sql`
      where true
      ${status && TX_STATUSES.includes(status) ? sql`and t.status = ${status}` : sql``}
      ${source && TX_SOURCES.includes(source) ? sql`and t.source = ${source}` : sql``}
      ${provider && TX_PROVIDERS.includes(provider) ? sql`and t.provider = ${provider}` : sql``}`

    let data: any[]
    let total: number
    try {
      ;[data, [{ count: total }]] = await Promise.all([
        sql`
          select t.id, t.plan_title, t.price_stars, t.duration_days, t.status, t.source, t.created_at,
            t.paid_at, t.provider, t.price_toman, t.tonpays_status,
            case when u.id is null then null
              else json_build_object('name', u.name, 'username', u.username) end as user
          from premium_transactions t
          left join users u on u.id = t.user_id
          ${where}
          order by t.created_at desc
          limit ${PAGE_SIZE} offset ${from}`,
        sql<{ count: number }[]>`select count(*)::int as count from premium_transactions t ${where}`,
      ])
    } catch {
      return reply.status(500).send({ error: 'transactions_fetch_failed' })
    }

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
        provider: r.provider,
        priceToman: r.price_toman ?? null,
        tonpaysStatus: r.tonpays_status ?? null,
      })),
      total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })

  app.post('/users/:id/premium/grant', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { days } = (req.body ?? {}) as { days?: unknown }
    if (!isPositiveInt(days) || days > 3650) return reply.status(400).send({ error: 'invalid_days' })

    const [user] = isUuid(id)
      ? await sql<{ id: string; premium_until: string | null }[]>`
          select id, premium_until from users where id = ${id}`.catch(() => [])
      : []
    if (!user) return reply.status(404).send({ error: 'user_not_found' })

    const premiumUntil = extendPremiumUntil(user.premium_until ?? null, days)
    try {
      await sql`update users set premium_until = ${premiumUntil} where id = ${id}`
    } catch {
      return reply.status(500).send({ error: 'grant_failed' })
    }

    // The grant already happened; a failed audit row is only logged.
    try {
      await sql`
        insert into premium_transactions
          (user_id, plan_id, plan_title, price_stars, duration_days, status, source, paid_at)
        values (${id}, null, 'Admin grant', 0, ${days}, 'paid', 'admin_grant', ${new Date().toISOString()})`
    } catch (txErr) {
      req.log.warn({ err: txErr }, 'failed to record admin grant tx')
    }

    return { premiumUntil }
  })

  app.post('/users/:id/premium/revoke', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'user_not_found' })
    let data: any
    try {
      ;[data] = await sql`update users set premium_until = null where id = ${id} returning id`
    } catch {
      return reply.status(500).send({ error: 'revoke_failed' })
    }
    if (!data) return reply.status(404).send({ error: 'user_not_found' })
    return { ok: true }
  })
}
