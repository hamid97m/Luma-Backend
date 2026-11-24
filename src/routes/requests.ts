import { FastifyInstance, FastifyReply } from 'fastify'
import { acceptRequest, ignoreRequest, listReceived, listSent, type RequestError } from '../requests/service.js'

const STATUS: Record<RequestError, number> = {
  request_not_found: 404,
  already_handled: 409,
  not_available: 410,
  match_failed: 500,
}

const answer = <T extends object>(reply: FastifyReply, result: T | { error: RequestError }) =>
  'error' in result ? reply.status(STATUS[result.error]).send(result) : result

export async function requestsRoutes(app: FastifyInstance) {
  app.get('/requests', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { requests: await listReceived(req.userId) }
  })

  app.get('/requests/sent', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { requests: await listSent(req.userId) }
  })

  app.post('/requests/:id/accept', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return answer(reply, await acceptRequest((req.params as { id: string }).id, req.userId))
  })

  app.post('/requests/:id/ignore', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return answer(reply, await ignoreRequest((req.params as { id: string }).id, req.userId))
  })
}
