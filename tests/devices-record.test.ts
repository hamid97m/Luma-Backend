import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/googleAuth.js', () => ({ verifyGoogleIdToken: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyGoogleIdToken } from '../src/googleAuth.js'
import { signSessionToken } from '../src/session.js'
import { parseClientInfo } from '../src/devices/clientInfo.js'
import { resetDeviceThrottle } from '../src/devices/record.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const HEADERS = {
  'x-device-id': 'dev-1',
  'x-client-platform': 'android',
  'x-client-version': '1.2.3',
  'x-device-model': 'Pixel 8',
  'x-device-os': 'Android 15',
}

async function waitForRows(n: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await sql`select * from user_devices order by id`
    if (rows.length >= n) return rows
    await new Promise((r) => setTimeout(r, 20))
  }
  return sql`select * from user_devices order by id`
}

describe('parseClientInfo', () => {
  it('reads all headers', () => {
    expect(parseClientInfo({ ...HEADERS, 'user-agent': 'okhttp/4' }, 'bearer')).toEqual({
      deviceId: 'dev-1', platform: 'android', appVersion: '1.2.3',
      deviceModel: 'Pixel 8', os: 'Android 15', userAgent: 'okhttp/4',
    })
  })
  it('truncates, strips control chars, falls back on platform', () => {
    expect(parseClientInfo({ ...HEADERS, 'x-device-model': 'm'.repeat(100) }, 'bearer')!.deviceModel).toHaveLength(64)
    expect(parseClientInfo({ ...HEADERS, 'x-device-model': 'a\nb' }, 'bearer')!.deviceModel).toBe('ab')
    expect(parseClientInfo({ ...HEADERS, 'x-client-platform': 'ios' }, 'bearer')!.platform).toBe('web')
    expect(parseClientInfo({ ...HEADERS, 'x-client-platform': 'ios' }, 'initData')!.platform).toBe('telegram')
  })
  it('null without a device id', () => {
    expect(parseClientInfo({}, 'bearer')).toBeNull()
    expect(parseClientInfo({ 'x-device-id': ' \n ' }, 'bearer')).toBeNull()
  })
})

describe('device recording', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    resetDeviceThrottle()
    app = await buildApp()
  })

  it('records a device on an authenticated request, throttled to once per 5 minutes', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    const headers = { authorization: `Bearer ${signSessionToken(u.id)}`, ...HEADERS }

    expect((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode).toBe(200)
    const [row] = await waitForRows(1)
    expect(row).toMatchObject({
      user_id: u.id, device_id: 'dev-1', platform: 'android', app_version: '1.2.3',
      device_model: 'Pixel 8', os: 'Android 15',
    })

    await app.inject({ method: 'GET', url: '/auth/me', headers })
    await new Promise((r) => setTimeout(r, 100))
    const [same] = await sql`select * from user_devices`
    expect(same.last_seen_at).toBe(row.last_seen_at)

    resetDeviceThrottle()
    await app.inject({ method: 'GET', url: '/auth/me', headers })
    for (let i = 0; i < 50; i++) {
      const [r] = await sql`select * from user_devices`
      if (new Date(r.last_seen_at) > new Date(row.last_seen_at)) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('last_seen_at was not refreshed after throttle reset')
  })

  it('POST /auth/google records the device', async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: 'g-1', email: 'ali@gmail.com', givenName: 'Ali' })
    const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { credential: 'x' }, headers: HEADERS })
    expect(res.statusCode).toBe(200)
    const [row] = await waitForRows(1)
    expect(row).toMatchObject({ user_id: res.json().user.id, device_id: 'dev-1', platform: 'android' })
  })

  it('requests without X-Device-Id succeed and create no row', async () => {
    const u = await createUser({ telegram_id: null, email: 'a@b.co' })
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${signSessionToken(u.id)}` } })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 100))
    expect(await sql`select id from user_devices`).toHaveLength(0)
  })

  it('CORS preflight allows the client headers', async () => {
    vi.stubEnv('WEB_URL', 'https://app.datinglumi.com')
    try {
      const a = await buildApp()
      const res = await a.inject({
        method: 'OPTIONS', url: '/auth/me',
        headers: {
          origin: 'https://app.datinglumi.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,x-client-platform,x-client-version,x-device-id,x-device-model,x-device-os',
        },
      })
      expect(res.statusCode).toBe(204)
      const allowed = String(res.headers['access-control-allow-headers']).toLowerCase()
      for (const h of ['x-client-platform', 'x-client-version', 'x-device-id', 'x-device-model', 'x-device-os']) {
        expect(allowed).toContain(h)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
