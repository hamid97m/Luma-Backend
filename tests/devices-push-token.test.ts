import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/googleAuth.js', () => ({ verifyGoogleIdToken: vi.fn() }))

import { buildApp } from '../src/server.js'
import { signSessionToken } from '../src/session.js'
import { resetDeviceThrottle } from '../src/devices/record.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const DEV = {
  'x-device-id': 'dev-1',
  'x-client-platform': 'android',
  'x-client-version': '1.2.3',
}

describe('push token endpoints', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    resetDeviceThrottle()
    app = await buildApp()
  })

  const auth = (id: string, extra: Record<string, string> = DEV) => ({
    authorization: `Bearer ${signSessionToken(id)}`, ...extra,
  })
  const put = (id: string, token: unknown, extra?: Record<string, string>) =>
    app.inject({ method: 'PUT', url: '/devices/push-token', payload: { token }, headers: auth(id, extra) })

  it('PUT stores the token and returns 204', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    const res = await put(u.id, 'tok-1')
    expect(res.statusCode).toBe(204)
    const rows = await sql`select * from user_devices where user_id = ${u.id}`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ device_id: 'dev-1', platform: 'android', push_token: 'tok-1' })
    expect(rows[0].push_token_at).not.toBeNull()
  })

  it('PUT without X-Device-Id is 400 missing_device_id', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    const res = await put(u.id, 'tok-1', {})
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing_device_id' })
  })

  it('PUT with empty, oversized or non-string token is 400 invalid_token', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    for (const t of ['', 'x'.repeat(1025), 123, undefined]) {
      const res = await put(u.id, t)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_token' })
    }
    expect((await put(u.id, 'x'.repeat(1024))).statusCode).toBe(204)
  })

  it('PUT without X-Client-Version keeps the stored app version', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    expect((await put(u.id, 'T1')).statusCode).toBe(204)
    expect((await put(u.id, 'T2', { 'x-device-id': 'dev-1', 'x-client-platform': 'android' })).statusCode).toBe(204)
    const [row] = await sql`select app_version, push_token from user_devices where user_id = ${u.id}`
    expect(row).toEqual({ app_version: '1.2.3', push_token: 'T2' })
  })

  it('moves a token between users on the same device', async () => {
    const a = await createUser({ telegram_id: null, email: 'a@b.co' })
    const b = await createUser({ telegram_id: null, email: 'b@b.co' })
    expect((await put(a.id, 'T')).statusCode).toBe(204)
    expect((await put(b.id, 'T')).statusCode).toBe(204)
    const [ra] = await sql`select push_token from user_devices where user_id = ${a.id}`
    const [rb] = await sql`select push_token from user_devices where user_id = ${b.id}`
    expect(ra.push_token).toBeNull()
    expect(rb.push_token).toBe('T')
  })

  it('DELETE clears the token and is idempotent', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    await put(u.id, 'tok-1')
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'DELETE', url: '/devices/push-token', headers: auth(u.id) })
      expect(res.statusCode).toBe(204)
    }
    const [row] = await sql`select push_token, push_token_at from user_devices where user_id = ${u.id}`
    expect(row.push_token).toBeNull()
    expect(row.push_token_at).toBeNull()
  })

  it('a paused user can PUT', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    await sql`update users set paused_at = now() where id = ${u.id}`
    expect((await put(u.id, 'tok-1')).statusCode).toBe(204)
  })
})
