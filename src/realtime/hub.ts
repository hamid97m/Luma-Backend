import { sql } from '../db.js'
import { loadMessagesByIds, type MessageJson } from '../messaging/messageJson.js'
import { parseTypingNotify } from './typing.js'

/**
 * Real-time chat hub: userId → that user's open SSE streams.
 *
 * Fed by the `luma_chat` NOTIFY payloads (see db/migrations/0001_messages_notify.sql
 * and listener.ts). Transport-agnostic — a stream is anything that can take a
 * serialized SSE chunk, so a WebSocket transport could register here too.
 *
 * Changes are buffered per match for a few ms (a mark-read UPDATE touches many
 * rows → many notifies) and loaded in one query per flush.
 *
 * Presence: a user is online while they have ≥1 open stream here. Going offline
 * waits PRESENCE_GRACE_MS after the last stream closes (cancelled when one
 * reopens), so an app switch or reconnect doesn't flicker. Each transition is
 * pushed as `presence` to the user's connected, visible counterparts.
 * Presence is per-process memory: correct for the single fork-mode process we
 * run; cluster mode would need shared presence (e.g. Redis or a NOTIFY channel).
 */

export const MAX_STREAMS_PER_USER = 3
const COALESCE_MS = 50
export const PRESENCE_GRACE_MS = 30_000

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
  /** The other user of every match of `userId` that is visible to both (same rule as GET /matches).
   *  Omitted → presence changes aren't pushed to anyone. */
  loadCounterparts?: (userId: string) => Promise<string[]>
  coalesceMs?: number
  /** Delay before a user with no open streams counts as offline. */
  presenceGraceMs?: number
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
  let presenceGraceMs = deps.presenceGraceMs ?? PRESENCE_GRACE_MS
  /** Users with no open stream who still count as online until their timer fires. */
  const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Last presence announcement per user — announcements of one user run in order. */
  const presenceChains = new Map<string, Promise<void>>()

  function isConnected(userId: string): boolean {
    return (streams.get(userId)?.size ?? 0) > 0
  }

  /** Connected now, or disconnected less than the grace period ago. */
  function isOnline(userId: string): boolean {
    return isConnected(userId) || offlineTimers.has(userId)
  }

  function remove(userId: string, stream: HubStream): void {
    const set = streams.get(userId)
    if (!set || !set.delete(stream)) return
    if (set.size > 0) return
    streams.delete(userId)
    const timer = setTimeout(() => {
      offlineTimers.delete(userId)
      if (!isConnected(userId)) announcePresence(userId, false)
    }, presenceGraceMs)
    timer.unref?.()
    offlineTimers.set(userId, timer)
  }

  /** Push `presence` to the user's connected, visible counterparts. One query,
   *  skipped when nobody else is connected at all. A failed load is logged and dropped. */
  function announcePresence(userId: string, online: boolean): void {
    if (!deps.loadCounterparts) return
    const othersConnected = streams.size > (isConnected(userId) ? 1 : 0)
    if (!othersConnected) return
    const load = deps.loadCounterparts
    const next = (presenceChains.get(userId) ?? Promise.resolve()).then(async () => {
      let ids: string[]
      try {
        ids = await load(userId)
      } catch (err) {
        deps.log?.warn({ err }, 'realtime: loading presence counterparts failed')
        return
      }
      const chunk = formatSse('presence', { userId, online })
      for (const id of new Set(ids)) if (id !== userId && isConnected(id)) sendTo(id, chunk)
    })
    presenceChains.set(userId, next)
    void next.finally(() => {
      if (presenceChains.get(userId) === next) presenceChains.delete(userId)
    })
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

  /** A just-opened stream: one `presence` online event per visible counterpart
   *  who is online now, so a (re)connecting client starts from the right state.
   *  Skips the query when no other user is online at all. Online-ness is read
   *  after the load, so a transition during it can't leave a stale "online". */
  function sendPresenceSnapshot(userId: string, stream: HubStream): void {
    if (!deps.loadCounterparts) return
    const anyoneElse =
      [...streams.keys()].some((u) => u !== userId) || [...offlineTimers.keys()].some((u) => u !== userId)
    if (!anyoneElse) return
    deps.loadCounterparts(userId).then(
      (ids) => {
        const chunk = [...new Set(ids)]
          .filter((id) => id !== userId && isOnline(id))
          .map((id) => formatSse('presence', { userId: id, online: true }))
          .join('')
        if (!chunk) return
        try {
          stream.write(chunk)
        } catch (err) {
          deps.log?.warn({ err }, 'realtime: stream write failed')
        }
      },
      (err) => deps.log?.warn({ err }, 'realtime: loading presence counterparts failed'),
    )
  }

  /** Register a stream; returns its unregister fn. Opening one past the
   *  per-user cap closes that user's oldest stream. */
  function addStream(userId: string, stream: HubStream): () => void {
    let set = streams.get(userId)
    const first = !set
    if (!set) streams.set(userId, (set = new Set()))
    set.add(stream)
    if (first) {
      // First stream: back within the grace period → still online, no event.
      const timer = offlineTimers.get(userId)
      if (timer) {
        clearTimeout(timer)
        offlineTimers.delete(userId)
      } else {
        announcePresence(userId, true)
      }
    }
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

  /** A `luma_typing` payload → `typing` to the counterpart's streams only.
   *  Sent immediately, no DB work; dropped when they aren't connected here. */
  function handleTyping(payload: string): void {
    const n = parseTypingNotify(payload)
    if (!n || n.to === n.from || !isConnected(n.to)) return
    sendTo(n.to, formatSse('typing', { matchId: n.matchId, userId: n.from }))
  }

  /** Every stream: "you may have missed events — refetch". */
  function resyncAll(): void {
    const chunk = formatSse('resync', {})
    for (const userId of streams.keys()) sendTo(userId, chunk)
  }

  return {
    addStream,
    handleNotify,
    handleTyping,
    resyncAll,
    isConnected,
    isOnline,
    sendPresenceSnapshot,
    /** Change the offline grace period (tests). Applies to streams closed afterwards. */
    setPresenceGraceMs: (ms: number) => {
      presenceGraceMs = ms
    },
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

/** The other user of each of `userId`'s matches, minus pairs hidden from each
 *  other (same rule as GET /matches): either side deleted, or a block either way. */
export async function loadCounterparts(userId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select o.id
    from matches m
    join users o on o.id = case when m.user1_id = ${userId} then m.user2_id else m.user1_id end
    where (m.user1_id = ${userId} or m.user2_id = ${userId})
      and o.deleted_at is null
      and not exists (select 1 from users me where me.id = ${userId} and me.deleted_at is not null)
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${userId} and b.blocked_id = o.id)
           or (b.blocker_id = o.id and b.blocked_id = ${userId})
      )`
  return rows.map((r) => r.id)
}

/** The process-wide hub used by GET /events and the LISTEN connection. */
export const chatHub = createChatHub({ loadMessages: loadMessagesByIds, pairVisible, loadCounterparts })
