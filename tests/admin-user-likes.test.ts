import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, createUser, createMatch, createPhoto, insertRow } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'

describe('GET /admin/users/:id/likes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  const get = async (url: string) => app.inject({ method: 'GET', url, headers })
  const like = (from: string, to: string, created_at: string, direction = 'like') =>
    insertRow('swipes', { swiper_id: from, swiped_id: to, direction, created_at })

  it('lists sent likes newest first with the other user and the match chat; passes excluded', async () => {
    const ali = await createUser({ name: 'Ali' })
    const sara = await createUser({ name: 'Sara', gender: 'woman' })
    const mina = await createUser({ name: 'Mina', gender: 'woman', is_seed: true, telegram_id: -3 })
    const nope = await createUser({ name: 'Nope' })
    await createPhoto(sara.id, 0, { url: 'https://s.jpg' })
    await like(ali.id, sara.id, '2026-08-01T00:00:00Z')
    await like(ali.id, mina.id, '2026-08-02T00:00:00Z')
    await like(ali.id, nope.id, '2026-08-03T00:00:00Z', 'pass')
    const m = await createMatch(sara.id, ali.id)

    const body = (await get(`/admin/users/${ali.id}/likes`)).json()
    expect(body).toMatchObject({ total: 2, page: 1, pageCount: 1 })
    expect(body.items).toEqual([
      { user: { id: mina.id, name: 'Mina', photo: null, isSeed: true }, likedAt: '2026-08-02T00:00:00.000Z', matchId: null },
      { user: { id: sara.id, name: 'Sara', photo: 'https://s.jpg', isSeed: false }, likedAt: '2026-08-01T00:00:00.000Z', matchId: m.id },
    ])
  })

  it('dir=received lists who liked the user; paginates; validates input', async () => {
    const sara = await createUser({ name: 'Sara', gender: 'woman' })
    for (let i = 0; i < 21; i++) {
      const u = await createUser({ name: `U${i}` })
      await like(u.id, sara.id, new Date(Date.parse('2026-08-01T00:00:00Z') + i * 60_000).toISOString())
    }
    const p2 = (await get(`/admin/users/${sara.id}/likes?dir=received&page=2`)).json()
    expect(p2).toMatchObject({ total: 21, page: 2, pageCount: 2 })
    expect(p2.items.map((i: any) => i.user.name)).toEqual(['U0'])
    expect((await get(`/admin/users/${sara.id}/likes`)).json().total).toBe(0)
    expect((await get(`/admin/users/${sara.id}/likes?dir=x`)).statusCode).toBe(400)
    expect((await get('/admin/users/nope/likes')).statusCode).toBe(404)
  })
})
