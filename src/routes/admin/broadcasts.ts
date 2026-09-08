import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { countAudience, fetchAudience, type BroadcastFilters } from '../../messaging/audience.js'
import { runBroadcast } from '../../messaging/broadcast.js'
import { sendBroadcastMessage, forwardBroadcastMessage, verifyForwardSource } from '../../bot.js'
import { validateButton } from '../../messaging/messageButton.js'
import { parseChannelMessageLink } from '../../messaging/channelLink.js'

const MAX_MESSAGE_LEN = 4096

function serialize(row: any) {
  return {
    id: row.id,
    kind: row.kind ?? 'text',
    message: row.message,
    filters: row.filters,
    status: row.status,
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    createdByUsername: row.created_by_username,
  }
}

/** Fire-and-forget: run the send loop and keep the job row in sync. `deliver`
 * sends to one recipient — a composed text DM or a channel forward. */
async function executeBroadcast(
  id: string,
  targets: { id: string; telegram_id: number }[],
  deliver: (telegramId: number) => Promise<void>,
  log: any,
) {
  try {
    const { sent, failed } = await runBroadcast(targets, {
      send: deliver,
      onOptOut: async (userId) => {
        await db.from('users').update({ allows_write_to_pm: false }).eq('id', userId)
      },
      onProgress: async ({ sent, failed }) => {
        await db.from('broadcasts').update({ sent_count: sent, failed_count: failed }).eq('id', id)
      },
    })
    await db.from('broadcasts').update({
      status: 'completed', sent_count: sent, failed_count: failed, finished_at: new Date().toISOString(),
    }).eq('id', id)
  } catch (err: any) {
    log?.error?.({ err }, 'broadcast execution failed')
    await db.from('broadcasts').update({
      status: 'failed', error: String(err?.message ?? err), finished_at: new Date().toISOString(),
    }).eq('id', id)
  }
}

export async function adminBroadcastsRoutes(app: FastifyInstance) {
  app.post('/broadcasts/preview', async (req) => {
    const { filters } = req.body as { filters?: BroadcastFilters }
    const count = await countAudience(db, filters ?? {})
    return { count }
  })

  app.post('/broadcasts', async (req, reply) => {
    const body = req.body as {
      kind?: string; message?: string; link?: string
      filters?: BroadcastFilters; button?: unknown
    }
    const isForward = body.kind === 'forward'
    const f = body.filters ?? {}

    // Row fields + the per-recipient delivery closure differ by kind; everything
    // downstream (audience, job loop, reporting) is shared.
    let insert: Record<string, unknown>
    let deliver: (telegramId: number) => Promise<void>

    if (isForward) {
      const parsed = parseChannelMessageLink(body.link ?? '')
      if (!parsed) return reply.status(400).send({ error: 'invalid_link' })

      // Pre-flight: confirm the bot can actually forward this message before we
      // enqueue it for the whole audience. Skips silently if no preview chat.
      try {
        await verifyForwardSource(parsed.chatId, parsed.messageId)
      } catch (err: any) {
        req.log.warn({ err }, 'forward source verification failed')
        return reply.status(400).send({
          error: 'forward_source_unreachable',
          detail: String(err?.description ?? err?.message ?? err),
        })
      }

      insert = {
        kind: 'forward',
        message: (body.link ?? '').trim(),
        source_chat_id: parsed.chatId,
        source_message_id: parsed.messageId,
      }
      deliver = (telegramId) => forwardBroadcastMessage(telegramId, parsed.chatId, parsed.messageId)
    } else {
      const trimmed = (body.message ?? '').trim()
      if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
      if (trimmed.length > MAX_MESSAGE_LEN) return reply.status(400).send({ error: 'message_too_long' })

      const btn = validateButton(body.button)
      if (!btn.ok) return reply.status(400).send({ error: btn.error })

      insert = { kind: 'text', message: trimmed }
      deliver = (telegramId) => sendBroadcastMessage(telegramId, trimmed, btn.button)
    }

    const targets = await fetchAudience(db, f)
    if (targets.length === 0) return reply.status(400).send({ error: 'empty_audience' })

    const { data: row, error } = await db.from('broadcasts').insert({
      created_by: req.adminId,
      created_by_username: req.adminUsername,
      filters: f,
      status: 'running',
      total_recipients: targets.length,
      ...insert,
    }).select('*').single()
    if (error || !row) {
      req.log.error({ err: error }, 'broadcast create failed')
      return reply.status(500).send({ error: 'broadcast_create_failed' })
    }

    void executeBroadcast(row.id, targets, deliver, req.log)
    return { broadcast: serialize(row) }
  })

  app.get('/broadcasts', async () => {
    const { data } = await db.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(100)
    return { items: (data ?? []).map(serialize) }
  })

  app.get('/broadcasts/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { data, error } = await db.from('broadcasts').select('*').eq('id', id).single()
    if (error && error.code !== 'PGRST116') {
      req.log.error({ err: error }, 'broadcast fetch failed')
      return reply.status(500).send({ error: 'broadcast_fetch_failed' })
    }
    if (!data) return reply.status(404).send({ error: 'broadcast_not_found' })
    return { broadcast: serialize(data) }
  })
}
