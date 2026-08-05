import { FastifyInstance } from 'fastify'
import { getPremiumStatus, createPremiumCheckout, getPremiumTransactionStatus } from '../premium/service.js'

export async function premiumRoutes(app: FastifyInstance) {
  app.get('/premium/status', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return getPremiumStatus(req.userId)
  })

  app.post('/premium/checkout', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { planId } = (req.body ?? {}) as { planId?: string }
    if (!planId) return reply.status(400).send({ error: 'plan_required' })
    const result = await createPremiumCheckout(req.userId, planId)
    if ('error' in result) return reply.status(400).send(result)
    return result
  })

  app.get('/premium/transactions/:id', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const status = await getPremiumTransactionStatus(id, req.userId)
    if (!status) return reply.status(404).send({ error: 'not_found' })
    return status
  })
}
