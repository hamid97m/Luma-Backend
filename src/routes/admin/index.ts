import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { verifyAdminToken } from './auth-utils.js'
import { adminAuthRoutes } from './auth.js'
import { adminStatsRoutes } from './stats.js'

declare module 'fastify' {
  interface FastifyRequest {
    adminId?: string
    adminUsername?: string
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routeOptions.url === '/admin/auth/login') return
    if (!process.env.ADMIN_JWT_SECRET) {
      return reply.status(503).send({ error: 'admin_not_configured' })
    }

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' })
    }
    const payload = verifyAdminToken(header.slice('Bearer '.length))
    if (!payload) return reply.status(401).send({ error: 'invalid_token' })

    req.adminId = payload.adminId
    req.adminUsername = payload.username
  })

  await app.register(adminAuthRoutes)
  await app.register(adminStatsRoutes)
}
