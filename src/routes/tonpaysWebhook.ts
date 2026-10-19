import { FastifyInstance } from 'fastify'
import { verifyTonPaysSignature } from '../payments/tonpays.js'
import { handleTonPaysPaid } from '../premium/service.js'
import { db } from '../db.js'

/**
 * TonPays (card-to-card gateway) webhook. Registered as its own plugin so the
 * scoped raw-body content-type parser below applies only within this
 * encapsulation context — every other route keeps Fastify's normal JSON
 * parsing. The HMAC must be verified over the exact bytes TonPays signed, not
 * a re-serialized JSON.parse/stringify round trip (which can differ in
 * whitespace/key order), so the body is kept as a Buffer until after the
 * signature check.
 */
export async function tonpaysWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.post(
    '/payments/tonpays/webhook',
    { config: { rateLimit: false }, logLevel: 'silent' },
    async (req, reply) => {
      const raw = req.body as Buffer
      const signature = req.headers['x-tonpays-signature'] as string | undefined
      const secret = process.env.TONPAYS_WEBHOOK_SECRET ?? ''
      if (!verifyTonPaysSignature(raw, signature, secret)) {
        return reply.status(401).send({ error: 'invalid_signature' })
      }

      let body: any
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        // Signed but unparseable — nothing sensible to act on; ack anyway so
        // TonPays doesn't retry forever on a body we'll never understand.
        return reply.status(200).send({ ok: true })
      }

      const invoiceId = body?.invoice_id as string | undefined
      if (!invoiceId) return reply.status(200).send({ ok: true })

      const event = req.headers['x-tonpays-event'] as string | undefined
      if (event === 'invoice.completed') {
        await handleTonPaysPaid(invoiceId)
        return reply.status(200).send({ ok: true })
      }

      // Any other event (status transitions, cancellations, mismatches): keep
      // tonpays_status in sync for admin visibility. A no-op when the invoice
      // isn't ours (0 rows matched) — never surfaced as an error.
      if (typeof body?.status === 'string') {
        await db.from('premium_transactions').update({ tonpays_status: body.status }).eq('tonpays_invoice_id', invoiceId)
      }
      return reply.status(200).send({ ok: true })
    },
  )
}
