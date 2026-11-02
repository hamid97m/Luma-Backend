import type { FastifyInstance } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { chatHub, formatSse, type ChatHub, type HubStream } from './hub.js'

export const HEARTBEAT_MS = 25_000 // Cloudflare idles a silent connection out at 100 s

/**
 * GET /events — one Server-Sent Events stream per open app (auth = the usual
 * initData preHandler). Events: ready, resync, message, message_updated,
 * message_deleted (see hub.ts). Exempt from the global rate limit; the hub caps
 * concurrent streams per user instead.
 */
export function eventsRoutes(hub: ChatHub = chatHub) {
  return async function (app: FastifyInstance) {
    // Streams opened through this app instance — ended on app.close() (before
    // the server stops; an open stream would otherwise keep close() waiting).
    const open = new Set<HubStream>()
    app.addHook('preClose', async () => {
      for (const s of [...open]) s.close()
    })

    app.get('/events', { config: { rateLimit: false } }, async (req, reply) => {
      if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
      const userId = req.userId

      // We own the socket from here. hijack() skips Fastify's send path, so the
      // CORS headers @fastify/cors put on `reply` must be copied over by hand.
      reply.hijack()
      const raw = reply.raw
      const headers: OutgoingHttpHeaders = {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      }
      delete headers['content-length']
      raw.writeHead(200, headers)
      raw.socket?.setNoDelay(true)

      let closed = false
      const write = (chunk: string) => {
        if (!closed && !raw.writableEnded && !raw.destroyed) raw.write(chunk)
      }
      const stream: HubStream = {
        write,
        close: () => cleanup(),
      }
      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)
      const unregister = hub.addStream(userId, stream)
      open.add(stream)

      function cleanup() {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unregister()
        open.delete(stream)
        if (!raw.writableEnded) raw.end()
      }
      raw.on('close', cleanup)

      write('retry: 3000\n\n')
      write(formatSse('ready', {}))
    })
  }
}
