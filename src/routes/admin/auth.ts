import { FastifyInstance, FastifyRequest } from 'fastify'
import type { errorResponseBuilderContext } from '@fastify/rate-limit'
import { sql } from '../../db.js'
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

    // A lookup failure answers like an unknown username (never reveals a DB
    // error). String() coerces a non-string username.
    let admin: { id: string; username: string; password_hash: string } | undefined
    try {
      ;[admin] = await sql<{ id: string; username: string; password_hash: string }[]>`
        select id, username, password_hash from admins where username = ${String(username)}`
    } catch (err) {
      req.log.error({ err }, 'admin lookup failed')
    }

    const passwordOk = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)
    if (!admin || !passwordOk) {
      return reply.status(401).send({ error: 'invalid_credentials' })
    }

    sql`update admins set last_login_at = ${new Date().toISOString()} where id = ${admin.id}`
      .then(() => {}, (err) => req.log.warn({ err }, 'failed to update last_login_at'))

    return { token: signAdminToken({ adminId: admin.id, username: admin.username }) }
  })

  app.get('/me', async (req) => ({ adminId: req.adminId, username: req.adminUsername }))
}
