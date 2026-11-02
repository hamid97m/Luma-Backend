import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))

import { buildApp } from '../src/server.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow } from './helpers/db.js'

describe('GET /matches excludes blocked participants', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => { await resetDb(); app = await buildApp() })

  it('drops a match whose other user is blocked (either direction)', async () => {
    const me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
    const blocked = await createUser({ name: 'Sara' })
    const blocker = await createUser({ name: 'Nika' })
    const friend = await createUser({ name: 'Mina' })
    await createMatch(me.id, blocked.id)
    await createMatch(blocker.id, me.id)
    const kept = await createMatch(me.id, friend.id)
    await insertRow('blocks', { blocker_id: me.id, blocked_id: blocked.id })
    await insertRow('blocks', { blocker_id: blocker.id, blocked_id: me.id })

    authAs(me)
    const res = await app.inject({ method: 'GET', url: '/matches', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().matches.map((m: any) => m.id)).toEqual([kept.id])
  })
})
