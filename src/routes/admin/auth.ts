import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { signAdminToken, verifyPassword } from './auth-utils.js'

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    if (!process.env.ADMIN_JWT_SECRET) {
      return reply.status(503).send({ error: 'admin_not_configured' })
    }

    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) return reply.status(400).send({ error: 'missing_credentials' })

    const { data: admin } = await db
      .from('admins')
      .select('id, username, password_hash')
      .eq('username', username)
      .single()

    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return reply.status(401).send({ error: 'invalid_credentials' })
    }

    db.from('admins')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', admin.id)
      .then(({ error }) => {
        if (error) req.log.warn({ err: error }, 'failed to update last_login_at')
      })

    return { token: signAdminToken({ adminId: admin.id, username: admin.username }) }
  })

  app.get('/me', async (req) => ({ adminId: req.adminId, username: req.adminUsername }))
}
