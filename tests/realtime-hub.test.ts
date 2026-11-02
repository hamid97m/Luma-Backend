import { describe, it, expect, vi } from 'vitest'
import { createChatHub, formatSse, parseChatNotify, MAX_STREAMS_PER_USER, type HubStream } from '../src/realtime/hub.js'
import type { MessageJson } from '../src/messaging/messageJson.js'

const M = 'm-1'
const A = 'user-a'
const B = 'user-b'

function msg(id: string, extra: Partial<MessageJson> = {}): MessageJson {
  return {
    id, senderId: A, body: 'hi', type: 'text', icebreakerAnswer: null, gift: null,
    createdAt: '2026-11-03T10:00:00.000Z', readAt: null, editedAt: null, replyToMessageId: null, ...extra,
  }
}

function fakeStream() {
  const chunks: string[] = []
  const s: HubStream & { chunks: string[]; closed: boolean } = {
    chunks, closed: false,
    write: (c) => { chunks.push(c) },
    close: () => { s.closed = true },
  }
  return s
}

/** Parse "event: x\ndata: {...}\n\n" blocks back into {event, data}. */
function events(chunks: string[]) {
  return chunks.join('').split('\n\n').filter(Boolean).map((block) => {
    const [ev, data] = block.split('\n')
    return { event: ev.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) }
  })
}

const notify = (op: string, id: string, matchId = M, u1 = A, u2 = B) =>
  JSON.stringify({ op, id, matchId, u1, u2 })

function makeHub(over: Partial<Parameters<typeof createChatHub>[0]> = {}) {
  const loadMessages = vi.fn(async (_m: string, ids: string[]) => ids.map((id) => msg(id)))
  const pairVisible = vi.fn(async () => true)
  const hub = createChatHub({ loadMessages, pairVisible, coalesceMs: 5, ...over })
  return { hub, loadMessages, pairVisible }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe('formatSse / parseChatNotify', () => {
  it('serializes one event with one-line JSON data', () => {
    expect(formatSse('message', { a: 'x\ny' })).toBe('event: message\ndata: {"a":"x\\ny"}\n\n')
  })

  it('accepts a well-formed payload and rejects junk', () => {
    expect(parseChatNotify(notify('INSERT', 'x'))).toEqual({ op: 'INSERT', id: 'x', matchId: M, u1: A, u2: B })
    expect(parseChatNotify('not json')).toBeNull()
    expect(parseChatNotify(notify('TRUNCATE', 'x'))).toBeNull()
    expect(parseChatNotify(JSON.stringify({ op: 'INSERT', id: 'x' }))).toBeNull()
  })
})

describe('chat hub', () => {
  it('delivers an INSERT as `message` to both connected participants', async () => {
    const { hub } = makeHub()
    const a = fakeStream()
    const b = fakeStream()
    hub.addStream(A, a)
    hub.addStream(B, b)
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(events(a.chunks)).toEqual([{ event: 'message', data: { matchId: M, message: msg('x1') } }])
    expect(events(b.chunks)).toEqual(events(a.chunks))
  })

  it('maps UPDATE → message_updated and DELETE → message_deleted (no load for deletes)', async () => {
    const { hub, loadMessages } = makeHub()
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('UPDATE', 'x1'))
    hub.handleNotify(notify('DELETE', 'x2'))
    await tick()
    expect(loadMessages).toHaveBeenCalledWith(M, ['x1'])
    expect(events(a.chunks)).toEqual([
      { event: 'message_updated', data: { matchId: M, message: msg('x1') } },
      { event: 'message_deleted', data: { matchId: M, messageId: 'x2' } },
    ])
  })

  it('skips all work when neither participant is connected', async () => {
    const { hub, loadMessages, pairVisible } = makeHub()
    hub.addStream('someone-else', fakeStream())
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(loadMessages).not.toHaveBeenCalled()
    expect(pairVisible).not.toHaveBeenCalled()
  })

  it('does not deliver to other users', async () => {
    const { hub } = makeHub()
    const a = fakeStream()
    const c = fakeStream()
    hub.addStream(A, a)
    hub.addStream('user-c', c)
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(a.chunks.length).toBe(1)
    expect(c.chunks).toEqual([])
  })

  it('coalesces a burst on one match into a single load (bulk read receipts)', async () => {
    const { hub, loadMessages } = makeHub()
    const a = fakeStream()
    hub.addStream(A, a)
    for (let i = 0; i < 20; i++) hub.handleNotify(notify('UPDATE', `r${i}`))
    await tick()
    expect(loadMessages).toHaveBeenCalledTimes(1)
    expect(loadMessages.mock.calls[0][1]).toHaveLength(20)
    expect(events(a.chunks).map((e) => e.event)).toEqual(Array(20).fill('message_updated'))
    expect(a.chunks).toHaveLength(1) // one write for the whole batch
  })

  it('merges ops per message: insert+update stays an insert, a delete wins', async () => {
    const { hub } = makeHub()
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'x1'))
    hub.handleNotify(notify('UPDATE', 'x1'))
    hub.handleNotify(notify('INSERT', 'x2'))
    hub.handleNotify(notify('DELETE', 'x2'))
    await tick()
    expect(events(a.chunks)).toEqual([
      { event: 'message', data: { matchId: M, message: msg('x1') } },
      { event: 'message_deleted', data: { matchId: M, messageId: 'x2' } },
    ])
  })

  it('drops an insert whose row is already gone by load time', async () => {
    const { hub } = makeHub({ loadMessages: vi.fn(async () => []) })
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(a.chunks).toEqual([])
  })

  it('delivers nothing when the pair is hidden (blocked / deleted)', async () => {
    const { hub, loadMessages } = makeHub({ pairVisible: vi.fn(async () => false) })
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(a.chunks).toEqual([])
    expect(loadMessages).not.toHaveBeenCalled()
  })

  it('sends resync to the participants when loading fails', async () => {
    const log = { warn: vi.fn() }
    const { hub } = makeHub({ loadMessages: vi.fn(async () => { throw new Error('db down') }), log })
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'x1'))
    await tick()
    expect(events(a.chunks)).toEqual([{ event: 'resync', data: {} }])
    expect(log.warn).toHaveBeenCalled()
  })

  it('caps streams per user: opening one more closes the oldest', () => {
    const { hub } = makeHub()
    const streams = Array.from({ length: MAX_STREAMS_PER_USER + 1 }, fakeStream)
    streams.forEach((s) => hub.addStream(A, s))
    expect(hub.streamCount(A)).toBe(MAX_STREAMS_PER_USER)
    expect(streams.map((s) => s.closed)).toEqual([true, ...Array(MAX_STREAMS_PER_USER).fill(false)])
  })

  it('unregister removes the stream; resyncAll reaches every open stream', () => {
    const { hub } = makeHub()
    const a = fakeStream()
    const b = fakeStream()
    const off = hub.addStream(A, a)
    hub.addStream(B, b)
    off()
    expect(hub.isConnected(A)).toBe(false)
    hub.resyncAll()
    expect(a.chunks).toEqual([])
    expect(events(b.chunks)).toEqual([{ event: 'resync', data: {} }])
  })

  it('a self-match delivers once per stream', async () => {
    const { hub } = makeHub()
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'x1', M, A, A))
    await tick()
    expect(a.chunks).toHaveLength(1)
  })
})

describe('chat hub ordering', () => {
  it('a later batch on the same match waits for a slow earlier one', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const loadMessages = vi.fn(async (_m: string, ids: string[]) => {
      if (ids.includes('slow')) await gate
      return ids.map((id) => msg(id))
    })
    const hub = createChatHub({ loadMessages, pairVisible: async () => true, coalesceMs: 1 })
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleNotify(notify('INSERT', 'slow'))
    await tick(10) // first batch is now loading
    hub.handleNotify(notify('UPDATE', 'slow'))
    await tick(10)
    expect(a.chunks).toEqual([])
    release()
    await tick(10)
    expect(events(a.chunks).map((e) => e.event)).toEqual(['message', 'message_updated'])
  })
})
