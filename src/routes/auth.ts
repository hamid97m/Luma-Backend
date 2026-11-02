import { FastifyInstance } from 'fastify'
import { verifyInitData } from '../auth.js'
import { signIn } from '../accounts.js'

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/verify', async (req, reply) => {
    const body = req.body as { initData?: string }
    const { initData } = body
    if (typeof initData !== 'string' || !initData) {
      return reply.status(400).send({ error: 'missing_init_data' })
    }

    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    const startParam = new URLSearchParams(initData).get('start_param')
    const result = await signIn({ kind: 'telegram', tgUser, startParam })
    return result.ok ? { user: result.user } : reply.status(result.status).send(result.body)
  })
}
