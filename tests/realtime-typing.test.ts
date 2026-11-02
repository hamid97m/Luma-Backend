import { describe, it, expect, vi } from 'vitest'
import { createChatHub, type HubStream } from '../src/realtime/hub.js'
import { createTypingTargetCache, parseTypingNotify } from '../src/realtime/typing.js'

const M = 'm-1'
const A = 'user-a'
const B = 'user-b'

function fakeStream() {
  const chunks: string[] = []
  const s: HubStream & { chunks: string[] } = { chunks, write: (c) => { chunks.push(c) }, close: () => {} }
  return s
}

function makeHub() {
  const loadMessages = vi.fn(async () => [])
  const pairVisible = vi.fn(async () => true)
  return { hub: createChatHub({ loadMessages, pairVisible, coalesceMs: 5 }), loadMessages, pairVisible }
}

const typing = (from: string, to: string, matchId = M) => JSON.stringify({ matchId, from, to })

describe('parseTypingNotify', () => {
  it('accepts a well-formed payload and rejects junk', () => {
    expect(parseTypingNotify(typing(A, B))).toEqual({ matchId: M, from: A, to: B })
    expect(parseTypingNotify('not json')).toBeNull()
    expect(parseTypingNotify('null')).toBeNull()
    expect(parseTypingNotify(JSON.stringify({ matchId: M, from: A }))).toBeNull()
  })
})

describe('hub typing', () => {
  it('delivers `typing` to the counterpart only — not the sender, not others', () => {
    const { hub, loadMessages, pairVisible } = makeHub()
    const a = fakeStream()
    const b1 = fakeStream()
    const b2 = fakeStream()
    const c = fakeStream()
    hub.addStream(A, a)
    hub.addStream(B, b1)
    hub.addStream(B, b2)
    hub.addStream('user-c', c)
    hub.handleTyping(typing(A, B))
    // Immediate (no coalescing delay) and on every one of B's streams.
    const expected = `event: typing\ndata: ${JSON.stringify({ matchId: M, userId: A })}\n\n`
    expect(b1.chunks).toEqual([expected])
    expect(b2.chunks).toEqual([expected])
    expect(a.chunks).toEqual([])
    expect(c.chunks).toEqual([])
    // No DB work for typing.
    expect(loadMessages).not.toHaveBeenCalled()
    expect(pairVisible).not.toHaveBeenCalled()
  })

  it('drops it when the counterpart is not connected, on junk, and on a self-match', () => {
    const { hub } = makeHub()
    const a = fakeStream()
    hub.addStream(A, a)
    hub.handleTyping(typing(A, B))
    hub.handleTyping('garbage')
    hub.handleTyping(typing(A, A))
    expect(a.chunks).toEqual([])
  })
})

describe('typing target cache', () => {
  it('returns the cached counterpart until the TTL passes', () => {
    let t = 1_000
    const cache = createTypingTargetCache({ ttlMs: 60_000, now: () => t })
    expect(cache.get(M, A)).toBeNull()
    cache.set(M, A, B)
    expect(cache.get(M, A)).toBe(B)
    expect(cache.get(M, B)).toBeNull() // keyed per (match, user)
    t += 59_999
    expect(cache.get(M, A)).toBe(B)
    t += 1
    expect(cache.get(M, A)).toBeNull()
    expect(cache.size).toBe(0) // expired entry removed on read
  })

  it('is bounded: past max entries the oldest goes', () => {
    const cache = createTypingTargetCache({ max: 2 })
    cache.set('m1', A, B)
    cache.set('m2', A, B)
    cache.set('m1', A, B) // refresh → m1 is now newest
    cache.set('m3', A, B)
    expect(cache.size).toBe(2)
    expect(cache.get('m2', A)).toBeNull()
    expect(cache.get('m1', A)).toBe(B)
    expect(cache.get('m3', A)).toBe(B)
  })
})
