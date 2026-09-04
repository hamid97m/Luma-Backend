import { createHash } from 'crypto'
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { verifyInitData } from './auth.js'
import { getBotUsername } from './bot.js'
import { WEBHOOK_ROUTE_PREFIX } from './webhookRoute.js'
import { db } from './db.js'
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
import { supportRoutes } from './routes/support.js'
import { adminRoutes } from './routes/admin/index.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | undefined
    telegramUser: TelegramUser
    isPaused?: boolean
  }
}

const LAST_ACTIVE_THROTTLE_MS = 60_000

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test'
      ? false
      : { level: process.env.LOG_LEVEL ?? 'warn' },
  })

  if (!process.env.WEB_URL && process.env.NODE_ENV === 'production') {
    throw new Error('WEB_URL environment variable is required in production')
  }

  const corsOrigins = [process.env.WEB_URL, process.env.ADMIN_WEB_URL]
    .filter((o): o is string => Boolean(o))

  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 hour',
    keyGenerator: (req: FastifyRequest) => {
      const auth = req.headers.authorization
      // Hash the full header: raw slicing gave all Bearer JWTs one shared bucket
      // (constant "Bearer eyJ..." prefix) and let attackers mint fresh buckets.
      return auth ? createHash('sha256').update(auth).digest('hex') : req.ip
    },
    errorResponseBuilder: () => ({ error: 'rate_limited' }),
  })

  // Auth middleware — skips /auth/verify and /health
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      req.url === '/auth/verify' ||
      req.url === '/health' ||
      req.url.startsWith('/admin') ||
      req.url.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`)
    ) return

    const initData = req.headers.authorization
    if (!initData) return reply.status(401).send({ error: 'missing_auth' })
    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    req.telegramUser = tgUser

    const { data } = await db
      .from('users')
      .select('id, deleted_at, banned_at, paused_at, last_active')
      .eq('telegram_id', tgUser.id)
      .single()

    if (!data) return reply.status(401).send({ error: 'user_not_found' })
    if (data.deleted_at) return reply.status(401).send({ error: 'account_deleted' })
    if (data.banned_at) return reply.status(401).send({ error: 'account_banned', botUsername: getBotUsername() })
    req.userId = data.id
    req.isPaused = Boolean(data.paused_at)

    if (data.last_active && Date.now() - new Date(data.last_active).getTime() > LAST_ACTIVE_THROTTLE_MS) {
      // Clearing notified_offline_at here means the very first request after
      // a period of inactivity is what "coming back online" resets against —
      // no separate heartbeat/reset job needed for the offline-notification throttle.
      db.from('users')
        .update({ last_active: new Date().toISOString(), notified_offline_at: null })
        .eq('id', data.id)
        .then(({ error }) => {
          if (error) req.log.warn({ err: error }, 'failed to update last_active')
        })
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
  await app.register(supportRoutes)
  await app.register(adminRoutes, { prefix: '/admin' })

  return app
}
