import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { verifyInitData } from './auth.js'
import { db } from './db.js'
import type { TelegramUser } from './types.js'
import { authRoutes } from './routes/auth.js'
import { profileRoutes } from './routes/profile.js'
import { photosRoutes } from './routes/photos.js'
import { discoveryRoutes } from './routes/discovery.js'
import { swipesRoutes } from './routes/swipes.js'
import { matchesRoutes } from './routes/matches.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | undefined
    telegramUser: TelegramUser
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  if (!process.env.WEB_URL && process.env.NODE_ENV === 'production') {
    throw new Error('WEB_URL environment variable is required in production')
  }

  await app.register(cors, {
    origin: process.env.WEB_URL ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 hour',
    keyGenerator: (req: FastifyRequest) => req.headers.authorization?.slice(0, 32) ?? req.ip,
    errorResponseBuilder: () => ({ error: 'rate_limited' }),
  })

  // Auth middleware — skips /auth/verify and /health
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/auth/verify' || req.url === '/health') return

    const initData = req.headers.authorization
    req.log.info({ initDataLen: initData?.length ?? 0, hasHash: initData?.includes('hash=') ?? false, botTokenSet: !!process.env.BOT_TOKEN }, 'auth check')
    if (!initData) return reply.status(401).send({ error: 'missing_auth' })
    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    req.telegramUser = tgUser

    const { data } = await db
      .from('users')
      .select('id')
      .eq('telegram_id', tgUser.id)
      .single()

    if (!data) return reply.status(401).send({ error: 'user_not_found' })
    req.userId = data.id
  })

  app.get('/health', async () => ({ ok: true }))

  await app.register(authRoutes)
  await app.register(profileRoutes)
  await app.register(photosRoutes)
  await app.register(discoveryRoutes)
  await app.register(swipesRoutes)
  await app.register(matchesRoutes)

  return app
}
