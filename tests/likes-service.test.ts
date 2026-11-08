import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getIncomingLikers, getIncomingLiker } from '../src/likes/service.js'
import { resetDb, createUser, createMatch, sql } from './helpers/db.js'
import { like, pass, block } from './helpers/discovery.js'

let me: Record<string, any>

/** A man who liked `me` on 2026-08-0<day>. */
async function liker(name: string, day: number, opts: Record<string, unknown> = {}) {
  const u = await createUser({
    name, gender: 'man', looking_for: 'women', location: 'Tehran', interests: ['Hiking', 'Music'], ...opts,
  })
  await like(u, me, { created_at: `2026-08-0${day}T00:00:00.000Z` })
  return u
}

beforeEach(async () => {
  await resetDb()
  me = await createUser({ name: 'Me', gender: 'woman', looking_for: 'men' })
})

describe('getIncomingLikers', () => {
  it('returns likers not yet acted on, newest first', async () => {
    const a1 = await liker('A1', 1, { gender: 'woman' })
    const a2 = await liker('A2', 2, { premium_until: '2099-01-01T00:00:00.000Z' })
    const res = await getIncomingLikers(me.id)
    expect(res.map((r) => r.id)).toEqual([a2.id, a1.id]) // created_at desc
    expect(res[0]).toEqual({
      id: a2.id, name: 'A2', age: 28, bio: null, location: 'Tehran', interests: ['Hiking', 'Music'],
      telegramId: a2.telegram_id, gender: 'man', likedAt: '2026-08-02T00:00:00.000Z', premium: true,
    })
    expect(res[1].gender).toBe('woman')
    expect(res[1].premium).toBe(false)
  })

  it('ignores passes aimed at me and likes aimed at someone else', async () => {
    const u = await createUser()
    await pass(u, me)
    const other = await createUser({ gender: 'woman' })
    await like(u, other)
    expect(await getIncomingLikers(me.id)).toEqual([])
  })

  it('excludes people I already swiped (either direction)', async () => {
    const a1 = await liker('A1', 1)
    const a2 = await liker('A2', 2)
    await pass(me, a1)
    await like(me, a2)
    expect(await getIncomingLikers(me.id)).toEqual([])
  })

  it('excludes matched partners (either column order)', async () => {
    const a1 = await liker('A1', 1)
    const a2 = await liker('A2', 2)
    await createMatch(me.id, a1.id)
    await createMatch(a2.id, me.id)
    expect(await getIncomingLikers(me.id)).toEqual([])
  })

  it('excludes blocked (either way), deleted, banned, and paused likers', async () => {
    const blockedByMe = await liker('B1', 1)
    const blockingMe = await liker('B2', 2)
    await block(me, blockedByMe)
    await block(blockingMe, me)
    await liker('D', 3, { deleted_at: '2026-08-05T00:00:00Z' })
    await liker('X', 4, { banned_at: '2026-08-05T00:00:00Z' })
    await liker('P', 5, { paused_at: '2026-08-05T00:00:00Z' })
    const ok = await liker('OK', 6)
    expect((await getIncomingLikers(me.id)).map((r) => r.id)).toEqual([ok.id])
  })

  it('excludes a deleted-then-returned liker whose profile was wiped', async () => {
    // Account delete blanks name/age; reopening the app clears deleted_at but leaves the wiped profile.
    await liker('', 1, { age: 0, account_status: 'preparing', deleted_at: null })
    const ok = await liker('OK', 2)
    expect((await getIncomingLikers(me.id)).map((r) => r.id)).toEqual([ok.id])
  })

  it('caps the list at the newest 100', async () => {
    const created: string[] = []
    for (let i = 0; i < 105; i++) {
      const u = await createUser({ gender: 'man' })
      await like(u, me, { created_at: new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString() })
      created.push(u.id)
    }
    const res = await getIncomingLikers(me.id)
    expect(res).toHaveLength(100)
    expect(res[0].id).toBe(created[104])
    expect(res.map((r) => r.id)).not.toContain(created[4])
  })

  it('returns [] instead of throwing on a read error (malformed id)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(getIncomingLikers('me')).resolves.toEqual([])
    errSpy.mockRestore()
  })
})

describe('getIncomingLiker', () => {
  it('returns the one liker in the IncomingLiker shape, with likedAt', async () => {
    const a2 = await liker('A2', 2, { premium_until: '2099-01-01T00:00:00.000Z' })
    await liker('A3', 3) // someone else's like doesn't matter
    expect(await getIncomingLiker(me.id, a2.id)).toEqual({
      id: a2.id, name: 'A2', age: 28, bio: null, location: 'Tehran', interests: ['Hiking', 'Music'],
      telegramId: a2.telegram_id, gender: 'man', likedAt: '2026-08-02T00:00:00.000Z', premium: true,
    })
  })

  it('returns null with no like row (a pass is not a like)', async () => {
    const u = await createUser()
    expect(await getIncomingLiker(me.id, u.id)).toBeNull()
    await pass(u, me)
    expect(await getIncomingLiker(me.id, u.id)).toBeNull()
  })

  it.each([
    ['deleted', async (u: any) => { await sql`update users set deleted_at = now() where id = ${u.id}` }],
    ['banned', async (u: any) => { await sql`update users set banned_at = now() where id = ${u.id}` }],
    ['paused', async (u: any) => { await sql`update users set paused_at = now() where id = ${u.id}` }],
    ['already swiped by her', async (u: any) => { await pass(me, u) }],
    ['blocked by her', async (u: any) => { await block(me, u) }],
    ['blocking her', async (u: any) => { await block(u, me) }],
    ['already matched', async (u: any) => { await createMatch(u.id, me.id) }],
  ] as Array<[string, (u: any) => Promise<void>]>)('returns null when %s', async (_name, kill) => {
    const a1 = await liker('A1', 1)
    await kill(a1)
    expect(await getIncomingLiker(me.id, a1.id)).toBeNull()
  })

  it('throws on a read error', async () => {
    await expect(getIncomingLiker(me.id, 'not-a-uuid')).rejects.toBeTruthy()
  })
})
