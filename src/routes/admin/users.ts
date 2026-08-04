import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'

export const PAGE_SIZE = 20

const GENDERS = ['man', 'woman', 'nonbinary']
const LOOKING = ['men', 'women', 'both', 'everyone']

export function toListItem(u: any) {
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.username,
    name: u.name,
    age: u.age,
    gender: u.gender,
    isActive: u.is_active,
    isSeed: u.is_seed,
    bannedAt: u.banned_at,
    deletedAt: u.deleted_at,
    createdAt: u.created_at,
    lastActive: u.last_active,
  }
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get('/users', async (req, reply) => {
    const { query = '', status = 'all', page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    let q: any = db
      .from('users')
      .select(
        'id, telegram_id, username, name, age, gender, is_active, is_seed, banned_at, deleted_at, created_at, last_active',
        { count: 'exact' }
      )

    if (status === 'active') q = q.is('deleted_at', null).is('banned_at', null)
    else if (status === 'banned') q = q.not('banned_at', 'is', null)
    else if (status === 'deleted') q = q.not('deleted_at', 'is', null)
    else if (status === 'seed') q = q.eq('is_seed', true)

    const search = query.trim()
    if (search) {
      const ors = [`name.ilike.%${search}%`, `username.ilike.%${search}%`]
      if (/^-?\d+$/.test(search)) ors.push(`telegram_id.eq.${search}`)
      q = q.or(ors.join(','))
    }

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'users_fetch_failed' })

    const total = count ?? 0
    return {
      items: (data ?? []).map(toListItem),
      total,
      page: pageNum,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    }
  })
}

export { GENDERS, LOOKING }
