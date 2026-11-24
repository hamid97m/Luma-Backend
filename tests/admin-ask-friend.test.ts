import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'
import { createProfile } from './helpers/discovery.js'

const HOUR = 3_600_000
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString()

describe('GET /admin/ask-friend', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const stats = async (q = '') => {
    const res = await app.inject({ method: 'GET', url: `/admin/ask-friend${q}`, headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  async function ask(requester: any, target: any, o: Record<string, unknown> = {}) {
    const created = (o.created_at as string) ?? ago(5)
    const [r] = await sql`insert into ask_requests ${sql({
      requester_id: requester.id, target_id: target.id, question: 'reply', created_at: created,
      expires_at: new Date(Date.parse(created) + 48 * HOUR).toISOString(), ...o,
    })} returning id`
    return r.id as string
  }
  const friend = (request_id: string, o: Record<string, unknown>) => sql`insert into ask_recipients ${sql({ request_id, kind: 'link', ...o })}`

  it('requires an admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/ask-friend' })).statusCode).toBe(401)
  })

  it('empty: zeros, no median, one row per day', async () => {
    const s = await stats('?days=7')
    expect(s.asks).toEqual({ total: 0, women: 0, withAnswer: 0, medianHoursToFirstAnswer: null })
    expect(s.friends).toEqual({ member: { sent: 0, viewed: 0, answered: 0 }, link: { sent: 0, viewed: 0, answered: 0 } })
    expect(s.perDay).toHaveLength(7)
    expect(s.perDay[6].date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('counts asks, friends, answers, outcomes, entry steps and friendships', async () => {
    const sara = await createProfile({ name: 'Sara' })
    const mina = await createProfile({ name: 'Mina' })
    const leila = await createProfile({ name: 'Leila' })
    const amir = await createProfile({ name: 'Amir', gender: 'man', looking_for: 'women' })
    const reza = await createProfile({ name: 'Reza', gender: 'man', looking_for: 'women' })

    const a = await ask(sara, amir)
    await friend(a, { kind: 'member', recipient_id: leila.id, seen_at: ago(4), answered_at: ago(3), verdict: 'yes', note: 'ok' })
    await friend(a, { seen_at: ago(4), answered_at: ago(1), verdict: 'no' })
    await friend(a, {})
    const b = await ask(sara, reza, { question: 'date', status: 'closed', closed_reason: 'liked', closed_at: ago(1) })
    await friend(b, { seen_at: ago(2) })
    // Past 48h but not swept by the job yet → expired.
    await ask(mina, amir, { created_at: ago(60) })
    // Outside the window.
    await ask(mina, reza, { created_at: ago(24 * 10), status: 'expired', closed_reason: 'expired', closed_at: ago(24 * 8) })

    const ev = (name: string, user_id: string | null) => sql`insert into ask_events ${sql({ name, user_id })}`
    await ev('ask_tooltip_shown', sara.id); await ev('ask_tooltip_shown', sara.id); await ev('ask_tooltip_shown', mina.id)
    await ev('ask_entry_tap', sara.id); await ev('ask_entry_tap', null)
    // Forged answers don't move the answer numbers.
    await ev('ask_answered', sara.id); await ev('ask_answered', null)
    await ev('advisor_converted', leila.id)
    const pair = (x: string, y: string, removed: string | null) => sql`
      insert into ask_friends (user_a, user_b, removed_at) select least(${x}::uuid, ${y}::uuid), greatest(${x}::uuid, ${y}::uuid), ${removed}`
    await pair(sara.id, leila.id, null); await pair(sara.id, mina.id, ago(1))

    const s = await stats('?days=7')
    expect(s.asks).toMatchObject({ total: 3, women: 2, withAnswer: 1 })
    expect(s.asks.medianHoursToFirstAnswer).toBeCloseTo(2, 1)
    expect(s.friends).toEqual({ member: { sent: 1, viewed: 1, answered: 1 }, link: { sent: 3, viewed: 2, answered: 1 } })
    expect(s.verdicts).toEqual({ yes: 1, unsure: 0, no: 1 })
    expect(s.notes).toBe(1)
    expect(Object.fromEntries(s.outcomes.map((o: any) => [o.outcome, o.count]))).toEqual({ open: 1, liked: 1, expired: 1 })
    expect(Object.fromEntries(s.byQuestion.map((o: any) => [o.question, o.count]))).toEqual({ reply: 2, date: 1 })
    expect(s.entry).toEqual({ sawTip: 2, tapped: 1, asked: 2 })
    expect(s.signups).toBe(1)
    expect(s.friendships).toEqual({ active: 1, removed: 1 })
    expect(s.perDay.reduce((n: number, d: any) => n + d.asks, 0)).toBe(3)
    expect(s.perDay.reduce((n: number, d: any) => n + d.answers, 0)).toBe(2)
    // No personal data.
    expect(JSON.stringify(s)).not.toMatch(/Sara|Leila|Amir|ok"/)

    expect((await stats('?days=30')).asks.total).toBe(4)
    expect((await stats('?days=1')).asks.total).toBe(2)
  })

  it('clamps days and answers 500 when the query fails', async () => {
    expect((await stats('?days=999')).days).toBe(30)
    expect((await stats('?days=abc')).days).toBe(7)
    await withTableBroken('ask_requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/ask-friend', headers })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'ask_friend_stats_failed' })
    })
  })
})
