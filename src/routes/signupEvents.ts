import { FastifyInstance, FastifyRequest } from 'fastify'
import { sql, isUuid } from '../db.js'
import { verifyInitData } from '../auth.js'
import { verifySessionToken } from '../session.js'
import { countSignupEvent } from '../metrics.js'

const MAX_EVENTS = 20
const EVENT_NAMES = new Set([
  'app_open', 'auth_ok', 'auth_failed', 'login_view', 'picker_view', 'picker_done', 'step_view',
  'photo_pick', 'photo_ok', 'photo_failed', 'submit_ok', 'submit_failed', 'page_hidden',
])
/** Onboarding order; the admin funnel sorts by it too. */
export const SIGNUP_STEPS = ['picker', 'name', 'city', 'age', 'gender', 'pref', 'interests', 'photo']
const PLATFORMS = ['telegram', 'web', 'android']
// This table must never hold user-typed content, so anything else is stored as null.
const DETAIL_RE = /^[a-z0-9_:.-]{1,32}$/
const LOCALE_RE = /^[A-Za-z0-9_-]{1,16}$/

interface SignupEventRow {
  session_id: string
  name: string
  step: string | null
  detail: string | null
  platform: string | null
  locale: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const matching = (v: unknown, re: RegExp): string | null =>
  typeof v === 'string' && re.test(v) ? v : null

const oneOf = (v: unknown, allowed: string[]): string | null =>
  typeof v === 'string' && allowed.includes(v) ? v : null

/** Accepted rows (possibly none, when every name is unknown); null = malformed body. */
function parseBody(body: unknown): SignupEventRow[] | null {
  if (!isObject(body) || !isUuid(body.sessionId)) return null
  const { sessionId, events } = body
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) return null
  if (!events.every((e) => isObject(e) && typeof e.name === 'string')) return null

  const platform = oneOf(body.platform, PLATFORMS)
  const locale = matching(body.locale, LOCALE_RE)
  return (events as { name: string; step?: unknown; detail?: unknown }[])
    .filter((e) => EVENT_NAMES.has(e.name))
    .map((e) => ({
      session_id: sessionId,
      name: e.name,
      step: oneOf(e.step, SIGNUP_STEPS),
      detail: matching(e.detail, DETAIL_RE),
      platform,
      locale,
    }))
}

/** Best-effort attribution: anything short of a known user is simply anonymous.
 *  Read-only on purpose (no reactivation, no last_active, no user creation). */
async function resolveUserId(req: FastifyRequest): Promise<string | null> {
  const authorization = req.headers.authorization
  if (!authorization) return null
  try {
    let where
    if (authorization.startsWith('Bearer ')) {
      const userId = verifySessionToken(authorization.slice('Bearer '.length))
      if (!userId) return null
      where = sql`id = ${userId}`
    } else {
      const tgUser = verifyInitData(authorization, process.env.BOT_TOKEN ?? '')
      if (!tgUser) return null
      where = sql`telegram_id = ${tgUser.id}`
    }
    const [user] = await sql<{ id: string }[]>`select id from users where ${where}`
    return user?.id ?? null
  } catch {
    return null
  }
}

/** Exempt from the auth hook (server.ts): the key case is a failed /auth/verify. */
export async function signupEventsRoutes(app: FastifyInstance) {
  app.post('/signup-events', {
    bodyLimit: 8 * 1024,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        // The global key hashes the Authorization header, and on this open route
        // a made-up header would mint a fresh bucket per request.
        keyGenerator: (req: FastifyRequest) => req.ip,
      },
    },
    // Body-parser rejections (bad JSON, too large, wrong content type) keep the
    // contract's error shape. Others pass through with their status: the 429 is
    // a plain object, which rethrowing would send as a 200.
    errorHandler: (err, _req, reply) => {
      const status = err.statusCode ?? 500
      if ([400, 413, 415].includes(status)) return reply.status(400).send({ error: 'invalid_events' })
      return reply.status(status).send(err)
    },
  }, async (req, reply) => {
    const rows = parseBody(req.body)
    if (!rows) return reply.status(400).send({ error: 'invalid_events' })

    if (rows.length > 0) {
      for (const row of rows) countSignupEvent(row.name, row.step)
      try {
        const user_id = await resolveUserId(req)
        await sql`insert into signup_events ${sql(rows.map((row) => ({ ...row, user_id })))}`
      } catch (err) {
        req.log.warn({ err }, 'signup events insert failed')
      }
    }
    return reply.status(204).send()
  })
}
