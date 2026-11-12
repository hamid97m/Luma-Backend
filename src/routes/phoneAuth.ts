import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { errorResponseBuilderContext } from '@fastify/rate-limit'
import { sql } from '../db.js'
import { signIn, releasePhoneFromDeleted } from '../accounts.js'
import { isSessionSecretConfigured, signSessionToken } from '../session.js'
import { parseClientInfo } from '../devices/clientInfo.js'
import { recordDevice } from '../devices/record.js'
import { normalizeIranMobile } from '../phone/normalize.js'
import { isSmsConfigured } from '../phone/mediana.js'
import { issueCode, verifyCode, normalizeCode, CODE_TTL_SECONDS, RESEND_COOLDOWN_SECONDS } from '../phone/otp.js'

// Native app only (product gate, not a security boundary: limits live in otp.ts).
const NATIVE_PLATFORMS = ['android']

/** Per-IP flood guard on top of the per-send limits in otp.ts. Generous:
 *  many Iranian mobile users share one carrier-NAT address. */
function ipLimit(max: number, timeWindow: string) {
  return {
    rateLimit: {
      max,
      timeWindow,
      keyGenerator: (req: FastifyRequest) => req.ip,
      // Same non-enumerable statusCode trick as server.ts / admin/auth.ts.
      errorResponseBuilder: (_req: FastifyRequest, context: errorResponseBuilderContext) => {
        const body = { error: 'rate_limited' }
        const statusCode = (context as unknown as { statusCode: number }).statusCode
        Object.defineProperty(body, 'statusCode', { value: statusCode, enumerable: false })
        return body
      },
    },
  }
}

/** Shared checks; sends the error reply and returns null when one fails. */
function precheck(req: FastifyRequest, reply: FastifyReply): string | null {
  // Checked before anything is written, like web login.
  if (!isSessionSecretConfigured() || (process.env.NODE_ENV === 'production' && !isSmsConfigured())) {
    reply.status(503).send({ error: 'phone_login_unavailable' })
    return null
  }
  const platform = String(req.headers['x-client-platform'] ?? '').trim().toLowerCase()
  if (!NATIVE_PLATFORMS.includes(platform)) {
    reply.status(403).send({ error: 'native_only' })
    return null
  }
  const phone = normalizeIranMobile((req.body as { phone?: unknown } | null)?.phone)
  if (!phone) {
    reply.status(400).send({ error: 'invalid_phone' })
    return null
  }
  return phone
}

const SENT = { ok: true, expiresIn: CODE_TTL_SECONDS, resendIn: RESEND_COOLDOWN_SECONDS }

export async function phoneAuthRoutes(app: FastifyInstance) {
  // Signed out: sign in or sign up with a phone. Answers the same whether or
  // not the number has an account.
  app.post('/auth/phone/request', { config: ipLimit(60, '10 minutes') }, async (req, reply) => {
    const phone = precheck(req, reply)
    if (!phone) return reply
    const result = await issueCode({ phone, purpose: 'login', userId: null, ip: req.ip, log: req.log })
    if (!result.ok) return reply.status(result.status).send(result.body)
    return SENT
  })

  app.post('/auth/phone/verify', { config: ipLimit(60, '15 minutes') }, async (req, reply) => {
    const phone = precheck(req, reply)
    if (!phone) return reply
    const code = normalizeCode((req.body as { code?: unknown }).code)
    if (!code) return reply.status(400).send({ error: 'invalid_code' })

    const checked = await verifyCode({ phone, purpose: 'login', userId: null, code })
    if (!checked.ok) return reply.status(checked.status).send(checked.body)

    const result = await signIn({ kind: 'phone', phone })
    if (!result.ok) return reply.status(result.status).send(result.body)
    recordDevice(result.userId, parseClientInfo(req.headers, 'bearer'), req.log)
    return { token: signSessionToken(result.userId), user: result.user, isNewUser: result.isNewUser }
  })

  // Signed in (behind the auth preHandler): attach a phone to the current account.
  app.post('/auth/phone/link/request', { config: ipLimit(60, '10 minutes') }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const phone = precheck(req, reply)
    if (!phone) return reply

    // Checked up front so no SMS is spent on a number that can't be linked.
    const [owner] = await sql<{ id: string; deleted_at: string | null; banned_at: string | null }[]>`
      select id, deleted_at, banned_at from users where phone = ${phone}`
    if (owner?.id === req.userId) return reply.status(409).send({ error: 'phone_already_linked' })
    if (owner && !(owner.deleted_at && !owner.banned_at)) return reply.status(409).send({ error: 'phone_in_use' })

    const result = await issueCode({ phone, purpose: 'link', userId: req.userId, ip: req.ip, log: req.log })
    if (!result.ok) return reply.status(result.status).send(result.body)
    return SENT
  })

  app.post('/auth/phone/link/verify', { config: ipLimit(60, '15 minutes') }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const phone = precheck(req, reply)
    if (!phone) return reply
    const code = normalizeCode((req.body as { code?: unknown }).code)
    if (!code) return reply.status(400).send({ error: 'invalid_code' })

    const checked = await verifyCode({ phone, purpose: 'link', userId: req.userId, code })
    if (!checked.ok) return reply.status(checked.status).send(checked.body)

    if (!(await releasePhoneFromDeleted(phone))) return reply.status(500).send({ error: 'phone_link_failed' })
    try {
      // Replaces any phone this account had before.
      await sql`update users set phone = ${phone} where id = ${req.userId}`
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.status(409).send({ error: 'phone_in_use' })
      req.log.error({ err }, 'phone link failed')
      return reply.status(500).send({ error: 'phone_link_failed' })
    }
    return { phone }
  })
}
