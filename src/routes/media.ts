import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { FastifyInstance } from 'fastify'
import { upload, verifyToken, resolveObjectFile, isPublicBucket, type Bucket } from '../storage.js'

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // matches nginx client_max_body_size

/**
 * Local-disk storage endpoints (see storage.ts). Registered without
 * fastify-plugin so the raw-body content-type parser stays scoped here.
 * All three paths are exempt from the initData auth hook in server.ts: the
 * signed token is the credential.
 */
export async function mediaRoutes(app: FastifyInstance) {
  // Clients PUT the raw image (Content-Type: image/jpeg) — the request shape they already use.
  for (const type of [/^image\//, 'application/octet-stream']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body))
  }

  // Tokens are ~130+ chars, over Fastify's default maxParamLength (100), which
  // turns a `:token` param route into a 404 — so match them as a wildcard.
  app.put<{ Params: { '*': string } }>(
    '/media-upload/*',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (req, reply) => {
      const claim = verifyToken(req.params['*'], 'put')
      if (!claim) return reply.status(403).send({ error: 'invalid_upload_token' })
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_upload' })
      }
      try {
        await upload(claim.b, claim.p, body)
      } catch (err) {
        req.log.error({ err }, 'media upload failed')
        return reply.status(500).send({ error: 'upload_failed' })
      }
      return { ok: true }
    },
  )

  app.get<{ Params: { '*': string } }>('/media-private/*', async (req, reply) => {
    const claim = verifyToken(req.params['*'], 'get')
    if (!claim) return reply.status(403).send({ error: 'invalid_media_token' })
    return sendFile(reply, claim.b, claim.p, 'private, max-age=300')
  })

  // Public files are served by nginx in production; this keeps local dev and
  // tests working without it.
  app.get<{ Params: { bucket: string; '*': string } }>('/media/:bucket/*', async (req, reply) => {
    const bucket = req.params.bucket as Bucket
    if (bucket !== 'profile-photos' || !isPublicBucket(bucket)) return reply.status(404).send({ error: 'not_found' })
    return sendFile(reply, bucket, req.params['*'], 'public, max-age=604800, immutable')
  })
}

async function sendFile(reply: import('fastify').FastifyReply, bucket: Bucket, path: string, cacheControl: string) {
  let file: string
  try {
    file = resolveObjectFile(bucket, path)
    if (!(await stat(file)).isFile()) throw new Error('not a file')
  } catch {
    return reply.status(404).send({ error: 'not_found' })
  }
  return reply
    .header('Content-Type', 'image/jpeg')
    .header('Cache-Control', cacheControl)
    .send(createReadStream(file))
}
