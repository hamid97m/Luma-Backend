import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))
// premium_config belongs to the premium area; pin the toggle ON here.
vi.mock('../src/premium/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/premium/service.js')>()
  return { ...real, isPremiumEnabled: vi.fn().mockResolvedValue(true) }
})

import { buildApp } from '../src/server.js'
import { isPremiumEnabled } from '../src/premium/service.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

describe('sending is free within the free-chat allowance, regardless of partner gender', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    vi.mocked(isPremiumEnabled).mockResolvedValue(true)
    app = await buildApp()
  })

  async function send(sender: Record<string, any>, partnerGender: string) {
    const partner = await createUser({ name: 'Sara', gender: partnerGender, looking_for: 'men' })
    const match = await createMatch(sender.id, partner.id)
    authAs(sender)
    const res = await app.inject({
      method: 'POST', url: `/matches/${match.id}/messages`, headers: AUTH, payload: { body: 'hi' },
    })
    return { res, match }
  }

  it('a free user can message a woman', async () => {
    const me = await createUser({ name: 'Me' })
    const { res, match } = await send(me, 'woman')
    expect(res.statusCode).toBe(200)
    const [row] = await sql`select id from messages where match_id = ${match.id}`
    expect(res.json().message.id).toBe(row.id)
  })

  it('a free user can message a man', async () => {
    const me = await createUser({ name: 'Me' })
    const { res } = await send(me, 'man')
    expect(res.statusCode).toBe(200)
  })

  it('an exempt sender (woman seeking men) never consults premium at all', async () => {
    const me = await createUser({ name: 'Me', gender: 'woman', looking_for: 'men' })
    const { res } = await send(me, 'man')
    expect(res.statusCode).toBe(200)
    expect(isPremiumEnabled).not.toHaveBeenCalled()
  })

  it('a gated free man past his free chats gets 403 premium_required for a NEW chat, but can keep replying', async () => {
    const me = await createUser({ name: 'Me' })
    const used: string[] = []
    for (const name of ['A', 'B']) {
      const p = await createUser({ name, gender: 'woman', looking_for: 'men' })
      const m = await createMatch(me.id, p.id)
      await insertRow('messages', { match_id: m.id, sender_id: me.id, body: 'hi' })
      used.push(m.id)
    }
    const { res, match } = await send(me, 'woman')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'premium_required' })
    expect(await sql`select id from messages where match_id = ${match.id}`).toHaveLength(0)

    const reply = await app.inject({ method: 'POST', url: `/matches/${used[0]}/messages`, headers: AUTH, payload: { body: 'again' } })
    expect(reply.statusCode).toBe(200)
  })
})
