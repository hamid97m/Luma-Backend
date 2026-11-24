import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { resolveObjectFile, isSafeObjectPath } from '../storage.js'
import { verifyAskPhotoSig } from '../asks/photoUrl.js'
import { verifyInitData } from '../auth.js'
import {
  askConfigFor, listFriends, createAsk, listMyAsks, getAskDetail, remindRecipient,
  getRecipientViewForMember, answerAsMember, openLink, answerByLink, parseClientEvent,
  recordAskEvent, requestIdForToken, askPhotoObject, type CreateAskInput, type LinkCaller,
  getAskTargetCard,
} from '../asks/service.js'

/** Link routes authenticate themselves: raw Telegram initData in Authorization
 *  (a non-member advisor has no users row, so the global preHandler skips
 *  `/asks/link/`). undefined = a header was sent but isn't valid initData. */
function linkCaller(req: FastifyRequest): LinkCaller | undefined {
  const auth = req.headers.authorization
  if (!auth) return null
  if (auth.startsWith('Bearer ')) return undefined
  const tg = verifyInitData(auth, process.env.BOT_TOKEN ?? '')
  return tg ? { tg } : undefined
}

const LINK_RATE_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } }

/** `.../profile-photos/<userId>/<photoId>` (any host: migrated files kept
 *  their paths) → the object path on local disk; null for anything else. */
export function profilePhotoObjectPath(url: string): string | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const marker = '/profile-photos/'
  const at = pathname.indexOf(marker)
  if (at < 0) return null
  const objectPath = decodeURIComponent(pathname.slice(at + marker.length))
  return isSafeObjectPath(objectPath) ? objectPath : null
}

export async function asksRoutes(app: FastifyInstance) {
  // ── Requester ──
  app.get('/asks/config', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return askConfigFor(req.userId)
  })

  app.get('/asks/friends', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { friends: await listFriends(req.userId) }
  })

  app.post('/asks', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const result = await createAsk(req.userId, (req.body ?? {}) as CreateAskInput)
    if (!result.ok) return reply.status(result.status).send(result.body)
    return { ask: result.ask, links: result.links }
  })

  app.get('/asks', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    return { asks: await listMyAsks(req.userId) }
  })

  app.post('/asks/events', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const e = parseClientEvent(req.body)
    if (!e) return reply.status(400).send({ error: 'invalid_event' })
    await recordAskEvent({ ...e, userId: req.userId, telegramId: req.telegramUser?.id ?? null })
    return reply.status(204).send()
  })

  // ── Member recipient ──
  app.get('/asks/for-me/:recipientId', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { recipientId } = req.params as { recipientId: string }
    const result = await getRecipientViewForMember(req.userId, recipientId)
    if (!result.ok) return reply.status(result.status).send(result.body)
    return result.view
  })

  app.post('/asks/for-me/:recipientId/answer', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { recipientId } = req.params as { recipientId: string }
    const result = await answerAsMember(req.userId, recipientId, req.body)
    if (!result.ok) return reply.status(result.status).send(result.body)
    return { ok: true }
  })

  // Her ask's person as a Discovery card — "back to this profile" from her asks list.
  app.get('/asks/:id/profile', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const card = await getAskTargetCard(req.userId, (req.params as { id: string }).id)
    if (!card) return reply.status(404).send({ error: 'not_found' })
    return { profile: card }
  })

  app.get('/asks/:id', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const detail = await getAskDetail(req.userId, id)
    if (!detail) return reply.status(404).send({ error: 'ask_not_found' })
    return detail
  })

  app.post('/asks/:id/remind/:recipientId', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const { id, recipientId } = req.params as { id: string; recipientId: string }
    const result = await remindRecipient(req.userId, id, recipientId)
    if (!result.ok) return reply.status(result.status).send(result.body)
    return { ok: true }
  })

  // ── Photo proxy (img tags send no headers; the signature is the credential) ──
  app.get('/asks/photo/:recipientId/:index', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { recipientId, index } = req.params as { recipientId: string; index: string }
    const { exp, sig } = req.query as { exp?: string; sig?: string }
    const i = /^\d{1,2}$/.test(index) ? Number(index) : -1
    const notFound = () => reply.status(404).send({ error: 'not_found' })
    if (i < 0 || !verifyAskPhotoSig(recipientId, i, exp, sig)) return notFound()
    const photo = await askPhotoObject(recipientId, i)
    const objectPath = photo && profilePhotoObjectPath(photo.url)
    if (!objectPath) return notFound()
    let file: string
    try {
      file = resolveObjectFile('profile-photos', objectPath)
      if (!(await stat(file)).isFile()) return notFound()
    } catch {
      return notFound()
    }
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(file))
  })

  // ── Public by token (no users row needed) ──
  app.get('/asks/link/:token', { config: LINK_RATE_LIMIT }, async (req, reply) => {
    const caller = linkCaller(req)
    if (caller === undefined) return reply.status(401).send({ error: 'invalid_init_data' })
    const { token } = req.params as { token: string }
    return openLink(token, caller)
  })

  app.post('/asks/link/:token/gender', { config: LINK_RATE_LIMIT }, async (req, reply) => {
    const caller = linkCaller(req)
    if (!caller) return reply.status(401).send({ error: caller === null ? 'missing_auth' : 'invalid_init_data' })
    const gender = ((req.body ?? {}) as { gender?: unknown }).gender
    if (gender !== 'female' && gender !== 'male') return reply.status(400).send({ error: 'invalid_gender' })
    const { token } = req.params as { token: string }
    return openLink(token, caller, { gender })
  })

  app.post('/asks/link/:token/answer', { config: LINK_RATE_LIMIT }, async (req, reply) => {
    const caller = linkCaller(req)
    if (!caller) return reply.status(401).send({ error: caller === null ? 'missing_auth' : 'invalid_init_data' })
    const { token } = req.params as { token: string }
    const result = await answerByLink(token, caller, req.body)
    if (!result.ok) return reply.status(result.status).send(result.body)
    return { ok: true }
  })

  app.post('/asks/link/:token/events', { config: LINK_RATE_LIMIT }, async (req, reply) => {
    const caller = linkCaller(req)
    const e = parseClientEvent(req.body)
    if (!e) return reply.status(400).send({ error: 'invalid_event' })
    const { token } = req.params as { token: string }
    await recordAskEvent({
      ...e,
      // The token decides the request, never the body.
      requestId: await requestIdForToken(token, caller ?? null),
      recipientKind: 'link',
      telegramId: caller ? caller.tg.id : null,
    })
    return reply.status(204).send()
  })
}
