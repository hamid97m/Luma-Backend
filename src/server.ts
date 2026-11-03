import { createHash } from 'crypto'
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import rateLimit, { type errorResponseBuilderContext } from '@fastify/rate-limit'
import { verifyInitData } from './auth.js'
import { verifySessionToken } from './session.js'
import { getBotUsername } from './bot.js'
import { WEBHOOK_ROUTE_PREFIX } from './webhookRoute.js'
import { sql } from './db.js'
import type { TelegramUser } from './types.js'
import { authRoutes } from './routes/auth.js'
import { profileRoutes } from './routes/profile.js'
import { photosRoutes } from './routes/photos.js'
import { discoveryRoutes } from './routes/discovery.js'
import { swipesRoutes } from './routes/swipes.js'
import { directChatRoutes } from './routes/directChat.js'
import { matchesRoutes } from './routes/matches.js'
import { likesRoutes } from './routes/likes.js'
import { messagesRoutes } from './routes/messages.js'
import { giftsRoutes } from './routes/gifts.js'
import { premiumRoutes } from './routes/premium.js'
import { reportsRoutes } from './routes/reports.js'
import { blockRoutes } from './routes/block.js'
import { supportRoutes } from './routes/support.js'
import { referralRoutes } from './routes/referrals.js'
import { adminRoutes } from './routes/admin/index.js'
import { tonpaysWebhookRoutes } from './routes/tonpaysWebhook.js'
import { mediaRoutes } from './routes/media.js'
import { eventsRoutes } from './realtime/eventsRoute.js'
import { registerHttpMetrics } from './metrics.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | undefined
    /** Set only on the Telegram initData path; undefined for website (Bearer) sessions. */
    telegramUser: TelegramUser | undefined
    isPaused?: boolean
  }
}

const LAST_ACTIVE_THROTTLE_MS = 60_000
const WEB_SIGN_IN_PATHS = new Set(['/auth/telegram-web', '/auth/google', '/auth/dev'])

/** The only way a paused user can come back is by uploading a fresh photo.
 *  Redeploy stamp: 2026-10-16T19:05. */
export function isPausedExempt(method: string, url: string): boolean {
  const path = url.split('?')[0]
  // Web bootstrap: like /auth/verify, answers with the profile (paused: true)
  // so the client can route to the photo-required screen.
  if (method === 'GET') return path === '/auth/me'
  if (method !== 'POST') return false
  return (
    path === '/profile/me/photos/upload-url' ||
    path === '/profile/me/photos/confirm' ||
    path === '/profile/me/photos/from-telegram' ||
    /^\/profile\/me\/photos\/[^/]+\/replace$/.test(path)
  )
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // nginx on the same host is the only proxy: trust X-Forwarded-For from
    // loopback only, so req.ip is the visitor (per-IP rate limits) and a
    // direct hit on :3000 can't spoof it.
    trustProxy: '127.0.0.1',
    logger: process.env.NODE_ENV === 'test'
      ? false
      : { level: process.env.LOG_LEVEL ?? 'warn' },
  })

  if (!process.env.WEB_URL && process.env.NODE_ENV === 'production') {
    throw new Error('WEB_URL environment variable is required in production')
  }

  registerHttpMetrics(app)

  // EXTRA_CORS_ORIGINS (comma-separated): e.g. a previous frontend host during a
  // migration, so Mini App links in old bot messages keep working.
  const corsOrigins = [
    process.env.WEB_URL,
    process.env.ADMIN_WEB_URL,
    ...(process.env.EXTRA_CORS_ORIGINS ?? '').split(','),
  ]
    .map((o) => o?.trim().replace(/\/+$/, ''))
    .filter((o): o is string => Boolean(o))

  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 hour',
    keyGenerator: (req: FastifyRequest) => {
      // Website sign-in carries no real credential in the header — key by IP so
      // a made-up Authorization value can't mint a fresh bucket per attempt.
      if (WEB_SIGN_IN_PATHS.has(req.url.split('?')[0])) return req.ip
      const auth = req.headers.authorization
      // Hash the full header: raw slicing gave all Bearer JWTs one shared bucket
      // (constant "Bearer eyJ..." prefix) and let attackers mint fresh buckets.
      return auth ? createHash('sha256').update(auth).digest('hex') : req.ip
    },
    // The plugin throws what this returns and takes the HTTP status from its
    // `.statusCode` (429, or 403 on ban); without it every limit hit was a 500.
    // Non-enumerable so it stays out of the JSON body (same as admin/auth.ts).
    errorResponseBuilder: (_req: FastifyRequest, context: errorResponseBuilderContext) => {
      const body = { error: 'rate_limited' }
      const statusCode = (context as unknown as { statusCode: number }).statusCode
      Object.defineProperty(body, 'statusCode', { value: statusCode, enumerable: false })
      return body
    },
  })

  // Auth middleware — skips the sign-in endpoints and /health
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      req.url === '/auth/verify' ||
      req.url === '/auth/telegram-web' ||
      req.url === '/auth/google' ||
      req.url === '/auth/dev' ||
      req.url === '/health' ||
      req.url.startsWith('/admin') ||
      req.url.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`) ||
      req.url.startsWith('/payments/tonpays/') ||
      req.url.startsWith('/media-upload/') ||
      req.url.startsWith('/media-private/') ||
      req.url.startsWith('/media/')
    ) return

    const authorization = req.headers.authorization
    if (!authorization) return reply.status(401).send({ error: 'missing_auth' })

    // Website sessions send `Bearer <jwt>`; the Mini App sends raw initData.
    let where
    if (authorization.startsWith('Bearer ')) {
      const userId = verifySessionToken(authorization.slice('Bearer '.length))
      if (!userId) return reply.status(401).send({ error: 'invalid_session' })
      where = sql`id = ${userId}`
    } else {
      const tgUser = verifyInitData(authorization, process.env.BOT_TOKEN ?? '')
      if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })
      req.telegramUser = tgUser
      where = sql`telegram_id = ${tgUser.id}`
    }

    const [data] = await sql<{
      id: string; deleted_at: string | null; banned_at: string | null
      paused_at: string | null; last_active: string | null
    }[]>`
      select id, deleted_at, banned_at, paused_at, last_active
      from users where ${where}`

    if (!data) return reply.status(401).send({ error: 'user_not_found' })
    if (data.deleted_at) return reply.status(401).send({ error: 'account_deleted' })
    if (data.banned_at) return reply.status(401).send({ error: 'account_banned', botUsername: getBotUsername() })
    req.userId = data.id
    req.isPaused = Boolean(data.paused_at)
    if (req.isPaused && !isPausedExempt(req.method, req.url)) {
      return reply.status(403).send({ error: 'account_paused' })
    }

    if (data.last_active && Date.now() - new Date(data.last_active).getTime() > LAST_ACTIVE_THROTTLE_MS) {
      // Clearing notified_offline_at here means the very first request after
      // a period of inactivity is what "coming back online" resets against —
      // no separate heartbeat/reset job needed for the offline-notification throttle.
      sql`
        update users set last_active = now(), notified_offline_at = null
        where id = ${data.id}`
        .catch((err) => req.log.warn({ err }, 'failed to update last_active'))
    }
  })

  app.get('/health', { logLevel: 'silent' }, async () => ({ ok: true }))

  await app.register(authRoutes)
  await app.register(profileRoutes)
  await app.register(photosRoutes)
  await app.register(discoveryRoutes)
  await app.register(swipesRoutes)
  await app.register(directChatRoutes)
  await app.register(matchesRoutes)
  await app.register(likesRoutes)
  await app.register(messagesRoutes)
  await app.register(giftsRoutes)
  await app.register(premiumRoutes)
  await app.register(reportsRoutes)
  await app.register(blockRoutes)
  await app.register(supportRoutes)
  await app.register(referralRoutes)
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.register(tonpaysWebhookRoutes)
  await app.register(mediaRoutes)
  await app.register(eventsRoutes())

  return app
}
