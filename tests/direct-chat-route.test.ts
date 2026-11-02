import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/premium/directChatLimit.js', () => ({ checkAndCountDirectChat: vi.fn() }))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { checkAndCountDirectChat } from '../src/premium/directChatLimit.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

const RESET_AT = '2026-09-06T12:00:00.000Z'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let target: Record<string, any>

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  me = await createUser({ name: 'Ali' })
  target = await createUser({ name: 'Sara', username: 'sara', gender: 'woman', looking_for: 'men' })
  authAs(me)
})

function post(targetUserId: unknown = target.id) {
  return app.inject({ method: 'POST', url: '/discovery/direct-chat', headers: AUTH, payload: { targetUserId } as any })
}

const matchesBetween = () => {
  const [u1, u2] = [me.id, target.id].sort()
  return sql`select id from matches where user1_id = ${u1} and user2_id = ${u2}`
}
const userPayload = () => ({ id: target.id, name: 'Sara', telegramId: target.telegram_id, username: 'sara' })

describe('POST /discovery/direct-chat', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/discovery/direct-chat', payload: { targetUserId: target.id } })
    expect(res.statusCode).toBe(401)
  })

  it('creates a match (normalized pair) for a free woman and returns created:true', async () => {
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'free' } as any)
    const res = await post()
    expect(res.statusCode).toBe(200)
    const rows = await matchesBetween()
    expect(rows).toHaveLength(1)
    expect(res.json()).toEqual({ created: true, match: { id: rows[0].id, user: userPayload() } })
  })

  it('seeds icebreakers (target first, then caller) for a newly created match', async () => {
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'free' } as any)
    const res = await post()
    expect(seedIcebreakers).toHaveBeenCalledTimes(1)
    expect(seedIcebreakers).toHaveBeenCalledWith(res.json().match.id, [target.id, me.id])
  })

  it('does not seed when the insert loses the race to an existing match (23505)', async () => {
    // A concurrent request creates the match between our existence check and our insert.
    let raced: Record<string, any> | undefined
    vi.mocked(checkAndCountDirectChat).mockImplementationOnce(async () => {
      const [u1, u2] = [me.id, target.id].sort()
      raced = await createMatch(u1, u2)
      return { gate: 'free' } as any
    })
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: false, match: { id: raced!.id, user: userPayload() } })
    expect(seedIcebreakers).not.toHaveBeenCalled()
    expect(await matchesBetween()).toHaveLength(1)
  })

  it('returns the existing match without consuming quota', async () => {
    const [u1, u2] = [me.id, target.id].sort()
    const existing = await createMatch(u1, u2)
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: false, match: { id: existing.id, user: userPayload() } })
    expect(checkAndCountDirectChat).not.toHaveBeenCalled()
    expect(seedIcebreakers).not.toHaveBeenCalled()
  })

  it('403 premium_required for a non-premium cohort man', async () => {
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'paywall' } as any)
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'premium_required' })
    expect(await matchesBetween()).toHaveLength(0)
  })

  it('403 direct_chat_limit with resetAt when the daily cap is hit', async () => {
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'quota', blocked: true, resetAt: RESET_AT } as any)
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'direct_chat_limit', resetAt: RESET_AT })
    expect(await matchesBetween()).toHaveLength(0)
  })

  it('creates a match for a premium man under the cap', async () => {
    vi.mocked(checkAndCountDirectChat).mockResolvedValue({ gate: 'quota', blocked: false, remaining: 2, resetAt: RESET_AT } as any)
    const res = await post()
    expect(res.statusCode).toBe(200)
    const [row] = await matchesBetween()
    expect(res.json()).toEqual({ created: true, match: { id: row.id, user: userPayload() }, directChat: { remaining: 2, resetAt: RESET_AT } })
  })

  it('404 when the target is missing/deleted', async () => {
    const gone = await createUser({ deleted_at: '2026-09-01T00:00:00Z' })
    for (const id of [gone.id, '00000000-0000-0000-0000-000000000000']) {
      const res = await post(id)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'user_not_found' })
    }
  })

  it('404 (not 500) for a malformed target id', async () => {
    const res = await post('not-a-uuid')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('403 blocked when a block exists in either direction', async () => {
    await insertRow('blocks', { blocker_id: target.id, blocked_id: me.id })
    const res = await post()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'blocked' })
    await sql`delete from blocks`
    await insertRow('blocks', { blocker_id: me.id, blocked_id: target.id })
    expect((await post()).json()).toEqual({ error: 'blocked' })
  })

  it('400 when targeting self', async () => {
    const res = await post(me.id)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_target' })
  })
})
