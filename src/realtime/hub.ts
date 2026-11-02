import { sql } from '../db.js'
import { loadMessagesByIds, type MessageJson } from '../messaging/messageJson.js'

/**
 * Real-time chat hub: userId → that user's open SSE streams.
 *
 * Fed by the `luma_chat` NOTIFY payloads (see db/migrations/0001_messages_notify.sql
 * and listener.ts). Transport-agnostic — a stream is anything that can take a
 * serialized SSE chunk, so a WebSocket transport could register here too.
 *
 * Changes are buffered per match for a few ms (a mark-read UPDATE touches many
 * rows → many notifies) and loaded in one query per flush.
 */

export const MAX_STREAMS_PER_USER = 3
const COALESCE_MS = 50

export interface HubStream {
  /** Write one serialized chunk (already SSE-formatted). */
  write(chunk: string): void
  /** End the stream (hub evicts it first). */
  close(): void
}

export type ChatOp = 'INSERT' | 'UPDATE' | 'DELETE'

export interface ChatNotify {
  op: ChatOp
  id: string
  matchId: string
  u1: string
  u2: string
}

export interface HubDeps {
  loadMessages: (matchId: string, ids: string[]) => Promise<MessageJson[]>
  /** False when the pair is hidden from each other: either side deleted, or a block either way. */
  pairVisible: (u1: string, u2: string) => Promise<boolean>
  coalesceMs?: number
  log?: { warn: (...a: any[]) => void }
}

/** One SSE event: `event:` name + one-line JSON `data:`. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const OPS = new Set<ChatOp>(['INSERT', 'UPDATE', 'DELETE'])

/** Parse a NOTIFY payload; null when malformed. */
export function parseChatNotify(payload: string): ChatNotify | null {
  try {
    const p = JSON.parse(payload)
    if (!p || !OPS.has(p.op)) return null
    for (const k of ['id', 'matchId', 'u1', 'u2']) if (typeof p[k] !== 'string') return null
    return { op: p.op, id: p.id, matchId: p.matchId, u1: p.u1, u2: p.u2 }
  } catch {
    return null
  }
}

interface PendingMatch {
  u1: string
  u2: string
  /** messageId → op, in first-seen order. */
  ops: Map<string, ChatOp>
}

export function createChatHub(deps: HubDeps) {
  const streams = new Map<string, Set<HubStream>>()
  const pending = new Map<string, PendingMatch>()
  /** Last scheduled flush per match — flushes of one match run one after another
   *  so its events never overtake each other. */
  const chains = new Map<string, Promise<void>>()
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS

  function isConnected(userId: string): boolean {
    return (streams.get(userId)?.size ?? 0) > 0
  }

  function remove(userId: string, stream: HubStream): void {
    const set = streams.get(userId)
    if (!set) return
    set.delete(stream)
    if (set.size === 0) streams.delete(userId)
  }

  function sendTo(userId: string, chunk: string): void {
    for (const s of streams.get(userId) ?? []) {
      try {
        s.write(chunk)
      } catch (err) {
        deps.log?.warn({ err }, 'realtime: stream write failed')
      }
    }
  }

  /** Register a stream; returns its unregister fn. Opening one past the
   *  per-user cap closes that user's oldest stream. */
  function addStream(userId: string, stream: HubStream): () => void {
    let set = streams.get(userId)
    if (!set) streams.set(userId, (set = new Set()))
    set.add(stream)
    while (set.size > MAX_STREAMS_PER_USER) {
      const oldest = set.values().next().value as HubStream
      set.delete(oldest)
      try {
        oldest.close()
      } catch {
        /* already gone */
      }
    }
    return () => remove(userId, stream)
  }

  function handleNotify(payload: string): void {
    const n = parseChatNotify(payload)
    if (!n) return
    // Nobody in this chat is connected → nothing to load.
    if (!isConnected(n.u1) && !isConnected(n.u2)) return

    let p = pending.get(n.matchId)
    if (!p) {
      p = { u1: n.u1, u2: n.u2, ops: new Map() }
      pending.set(n.matchId, p)
      const matchId = n.matchId
      setTimeout(() => {
        const next = (chains.get(matchId) ?? Promise.resolve()).then(() => flush(matchId))
        chains.set(matchId, next)
        void next.finally(() => {
          if (chains.get(matchId) === next) chains.delete(matchId)
        })
      }, coalesceMs)
    }
    // Merge per message: a delete wins; an insert stays an insert even if it
    // was updated within the window (the loaded row is the latest anyway).
    const prev = p.ops.get(n.id)
    if (n.op === 'DELETE' || !prev) p.ops.set(n.id, n.op)
  }

  async function flush(matchId: string): Promise<void> {
    const p = pending.get(matchId)
    pending.delete(matchId)
    if (!p) return
    const recipients = [p.u1, p.u2].filter((u, i, a) => isConnected(u) && a.indexOf(u) === i)
    if (recipients.length === 0) return

    let rows: MessageJson[]
    try {
      if (!(await deps.pairVisible(p.u1, p.u2))) return
      const loadIds = [...p.ops].filter(([, op]) => op !== 'DELETE').map(([id]) => id)
      rows = await deps.loadMessages(matchId, loadIds)
    } catch (err) {
      // Events lost — tell the participants to refetch rather than drop silently.
      deps.log?.warn({ err }, 'realtime: loading changed messages failed')
      for (const u of recipients) sendTo(u, formatSse('resync', {}))
      return
    }

    const byId = new Map(rows.map((m) => [m.id, m]))
    const chunks: string[] = []
    for (const [id, op] of p.ops) {
      if (op === 'DELETE') {
        chunks.push(formatSse('message_deleted', { matchId, messageId: id }))
        continue
      }
      const message = byId.get(id)
      if (!message) continue // deleted again before we loaded it
      chunks.push(formatSse(op === 'INSERT' ? 'message' : 'message_updated', { matchId, message }))
    }
    if (chunks.length === 0) return
    const chunk = chunks.join('')
    for (const u of recipients) sendTo(u, chunk)
  }

  /** Every stream: "you may have missed events — refetch". */
  function resyncAll(): void {
    const chunk = formatSse('resync', {})
    for (const userId of streams.keys()) sendTo(userId, chunk)
  }

  return {
    addStream,
    handleNotify,
    resyncAll,
    isConnected,
    /** Open streams for a user (tests/diagnostics). */
    streamCount: (userId: string) => streams.get(userId)?.size ?? 0,
  }
}

export type ChatHub = ReturnType<typeof createChatHub>

/** Same hiding rule as the GET /matches list: deleted counterpart or a block either way. */
async function pairVisible(u1: string, u2: string): Promise<boolean> {
  const [row] = await sql<{ visible: boolean }[]>`
    select (
      not exists (select 1 from users where id in (${u1}, ${u2}) and deleted_at is not null)
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${u1} and b.blocked_id = ${u2})
           or (b.blocker_id = ${u2} and b.blocked_id = ${u1})
      )
    ) as visible`
  return Boolean(row?.visible)
}

/** The process-wide hub used by GET /events and the LISTEN connection. */
export const chatHub = createChatHub({ loadMessages: loadMessagesByIds, pairVisible })
