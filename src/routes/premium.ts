import { FastifyInstance } from 'fastify'
import {
  getPremiumStatus, createPremiumCheckout, getPremiumTransactionStatus,
  changeTonPaysCard, submitTonPaysRefundCard,
} from '../premium/service.js'

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

  app.post('/premium/transactions/:id/change-card', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const result = await changeTonPaysCard(id, req.userId)
    if (result.ok) return { cardNumber: result.cardNumber, cardHolder: result.cardHolder }
    if (result.code === 'not_found') return reply.status(404).send({ error: 'not_found' })
    if (result.code === 'cooldown') return reply.status(429).send({ error: 'change_card_cooldown' })
    if (result.code === 'invalid_request') return reply.status(400).send({ error: 'change_card_failed' })
    return reply.status(502).send({ error: 'tonpays_unavailable' })
  })

  app.post('/premium/transactions/:id/refund-card', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const { cardNumber, cardHolder } = (req.body ?? {}) as { cardNumber?: string; cardHolder?: string }
    const result = await submitTonPaysRefundCard(id, req.userId, cardNumber ?? '', cardHolder ?? '')
    if (result.ok) return { ok: true }
    if (result.code === 'not_found') return reply.status(404).send({ error: 'not_found' })
    if (result.code === 'invalid_card') return reply.status(400).send({ error: 'invalid_card' })
    return reply.status(502).send({ error: 'tonpays_unavailable' })
  })
}
