import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withTableBroken } from './helpers/admin-db-fault.js'

describe('GET /admin/users/:id', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let sara: Record<string, any>
  let ali: Record<string, any>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
    sara = await createUser({
      telegram_id: 42, username: 'sara', name: 'Sara', age: 24, gender: 'woman', looking_for: 'men',
      bio: 'hi', interests: ['music'], location: 'Tehran', allows_write_to_pm: true,
    })
    ali = await createUser({ name: 'Ali' })
  })

  const get = (id: string) => app.inject({ method: 'GET', url: `/admin/users/${id}`, headers })

  it('returns profile, counts, and matches with the other user resolved', async () => {
    await createPhoto(sara.id, 1, { url: 'https://p2.jpg' })
    await createPhoto(sara.id, 0, { url: 'https://p1.jpg' })
    await createPhoto(ali.id, 1, { url: 'https://a2.jpg' })
    await createPhoto(ali.id, 0, { url: 'https://a.jpg' })
    const reza = await createUser({ name: 'Reza' })
    const m1 = await createMatch(sara.id, ali.id, { created_at: '2026-08-02T00:00:00Z' })
    const m2 = await createMatch(reza.id, sara.id, { created_at: '2026-08-03T00:00:00Z' })
    await insertRow('swipes', { swiper_id: sara.id, swiped_id: ali.id, direction: 'like' })
    await insertRow('swipes', { swiper_id: sara.id, swiped_id: reza.id, direction: 'pass' })
    await insertRow('swipes', { swiper_id: ali.id, swiped_id: sara.id, direction: 'like' })
    await insertRow('swipes', { swiper_id: reza.id, swiped_id: sara.id, direction: 'pass' })
    await insertRow('messages', { match_id: m1.id, sender_id: sara.id, body: 'hey' })
    await insertRow('messages', { match_id: m1.id, sender_id: ali.id, body: 'yo' })

    const res = await get(sara.id)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toMatchObject({
      id: sara.id, telegramId: 42, name: 'Sara', lookingFor: 'men', bio: 'hi', interests: ['music'],
      location: 'Tehran', allowsWriteToPm: true, premiumUntil: null, locale: null,
      photos: ['https://p1.jpg', 'https://p2.jpg'],
    })
    expect(body.counts).toEqual({ swipesGiven: 2, likesReceived: 1, matches: 2, messagesSent: 1 })
    expect(body.matches).toEqual([
      { matchId: m2.id, matchedAt: '2026-08-03T00:00:00.000Z', user: { id: reza.id, name: 'Reza', photo: null } },
      { matchId: m1.id, matchedAt: '2026-08-02T00:00:00.000Z', user: { id: ali.id, name: 'Ali', photo: 'https://a.jpg' } },
    ])
  })

  it('shows email and signInMethods for a Google user without telegram', async () => {
    const web = await createUser({ telegram_id: null, email: 'web@example.com', google_sub: 'g-123' })
    const body = (await get(web.id)).json()
    expect(body.user).toMatchObject({ telegramId: null, email: 'web@example.com', signInMethods: ['google', 'email'] })
  })

  it('lists telegram only for real telegram users and none for seeds', async () => {
    const seed = await createUser({ telegram_id: -5, is_seed: true })
    expect((await get(sara.id)).json().user).toMatchObject({ email: null, signInMethods: ['telegram'] })
    expect((await get(seed.id)).json().user.signInMethods).toEqual([])
  })

  it('excludes icebreaker rows from messages sent', async () => {
    const m = await createMatch(sara.id, ali.id)
    await insertRow('messages', { match_id: m.id, sender_id: sara.id, body: 'q?', type: 'icebreaker' })
    await insertRow('messages', { match_id: m.id, sender_id: sara.id, body: 'hi' })

    const res = await get(sara.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().counts.messagesSent).toBe(1)
  })

  it('shows deleted users to admins', async () => {
    await sql`update users set deleted_at = now() where id = ${sara.id}`
    const res = await get(sara.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().user.deletedAt).toBeTruthy()
  })

  it('returns 404 for an unknown user', async () => {
    const res = await get('00000000-0000-0000-0000-000000000000')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('returns 404 (not 500) for a malformed id', async () => {
    const res = await get('nope')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'user_not_found' })
  })

  it('returns 500 when a sub-query fails', async () => {
    const res = await withTableBroken('swipes', () => get(sara.id))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'user_detail_fetch_failed' })
  })
})
