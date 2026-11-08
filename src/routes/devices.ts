import { FastifyInstance } from 'fastify'
import { parseClientInfo } from '../devices/clientInfo.js'
import { setPushToken, clearPushToken } from '../devices/pushToken.js'

const MAX_TOKEN = 1024 // btree index row limit; real FCM tokens are ~160 chars

export async function devicesRoutes(app: FastifyInstance) {
  const authKind = (req: { headers: { authorization?: string } }) =>
    (req.headers.authorization ?? '').startsWith('Bearer ') ? 'bearer' : 'initData'

  app.put('/devices/push-token', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const info = parseClientInfo(req.headers, authKind(req))
    if (!info) return reply.status(400).send({ error: 'missing_device_id' })
    const token = (req.body as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN) {
      return reply.status(400).send({ error: 'invalid_token' })
    }
    await setPushToken(req.userId, info, token)
    return reply.status(204).send()
  })

  app.delete('/devices/push-token', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const info = parseClientInfo(req.headers, authKind(req))
    if (!info) return reply.status(400).send({ error: 'missing_device_id' })
    await clearPushToken(req.userId, info.deviceId)
    return reply.status(204).send()
  })
}
