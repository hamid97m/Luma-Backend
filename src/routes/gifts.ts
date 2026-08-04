import { FastifyInstance } from 'fastify'
import {
  getCatalogForBuyer, createGiftCheckout, getTransactionStatus,
  listPendingIntros, acceptIntro, dismissIntro,
} from '../gifts/service.js'

export async function giftsRoutes(app: FastifyInstance) {
  app.get('/gifts/catalog', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { gifts: await getCatalogForBuyer() }
  })

  app.post('/gifts/checkout', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { context, matchId, targetUserId, giftId, note } = req.body as {
      context: 'chat' | 'discovery'; matchId?: string; targetUserId?: string; giftId: string; note?: string
    }
    if (context !== 'chat' && context !== 'discovery') return reply.status(400).send({ error: 'bad_context' })
    if (!giftId) return reply.status(400).send({ error: 'gift_required' })
    const result = await createGiftCheckout({ buyerId: req.userId, context, matchId, targetUserId, giftId, note })
    if ('error' in result) return reply.status(400).send(result)
    return result
  })

  app.get('/gifts/transactions/:id', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const status = await getTransactionStatus(id, req.userId)
    if (!status) return reply.status(404).send({ error: 'not_found' })
    return status
  })

  app.get('/gifts/intros', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { intros: await listPendingIntros(req.userId) }
  })

  app.post('/gifts/intros/:id/accept', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const result = await acceptIntro(id, req.userId)
    if ('error' in result) return reply.status(400).send(result)
    return result
  })

  app.post('/gifts/intros/:id/dismiss', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const result = await dismissIntro(id, req.userId)
    if ('error' in result) return reply.status(400).send(result)
    return { ok: true }
  })
}
