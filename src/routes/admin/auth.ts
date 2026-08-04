import { FastifyInstance, FastifyRequest } from 'fastify'
import type { errorResponseBuilderContext } from '@fastify/rate-limit'
import { db } from '../../db.js'
import { signAdminToken, verifyPassword } from './auth-utils.js'

// Precomputed bcrypt hash of an arbitrary password — used in place of a real
// password_hash for unknown usernames so bcrypt always runs once per login
// attempt, equalizing response timing and preventing username enumeration.
const DUMMY_HASH = '$2b$10$7fhpYqlmsR39k/Qu2m.kJOYd4yI8SgM7RB4jj6.470sELbPljPhBm'

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req: FastifyRequest) => req.ip,
        // The plugin throws whatever this returns and reads `.statusCode` off it
        // to set the HTTP status — but also serializes the object verbatim as the
        // body, so `statusCode` must be non-enumerable to keep it out of the JSON.
        // (The package's type for `context` omits `statusCode`, though it's always
        // set at runtime — see @fastify/rate-limit's respCtx in index.js.)
        errorResponseBuilder: (_req: FastifyRequest, context: errorResponseBuilderContext) => {
          const body = { error: 'rate_limited' }
          const statusCode = (context as unknown as { statusCode: number }).statusCode
          Object.defineProperty(body, 'statusCode', { value: statusCode, enumerable: false })
          return body
        },
      },
    },
  }, async (req, reply) => {
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

    const passwordOk = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)
    if (!admin || !passwordOk) {
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
