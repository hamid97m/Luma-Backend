import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

vi.mock('../src/bot.js', () => ({
  notifyPaused: vi.fn(() => Promise.resolve()),
  sendBroadcastMessage: vi.fn(() => Promise.resolve()),
  forwardBroadcastMessage: vi.fn(() => Promise.resolve()),
}))

import { buildApp } from '../src/server.js'
import { sendBroadcastMessage, forwardBroadcastMessage } from '../src/bot.js'
import { resetDb, createUser, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { initPush, __setPushTransportForTests } from '../src/push/fcm.js'

let tmp: string
let bodies: any[]
const saved: Record<string, string | undefined> = {}
const envKeys = ['FCM_SERVICE_ACCOUNT_FILE', 'APP_MODE', 'WEB_URL'] as const

async function enablePush() {
  const keyFile = path.join(tmp, 'sa.json')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  fs.writeFileSync(keyFile, JSON.stringify({
    type: 'service_account', project_id: 'proj-x', private_key: privateKey,
    client_email: 'sa@proj-x.iam.gserviceaccount.com',
  }))
  process.env.FCM_SERVICE_ACCOUNT_FILE = keyFile
  await initPush()
}

async function addToken(userId: string, token = 'tok-' + userId) {
  await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at)
            values (${userId}, ${'d-' + token}, 'android', ${token}, now())`
}

describe('admin user devices / push', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const k of envKeys) saved[k] = process.env[k]
    process.env.WEB_URL = 'https://luma.test'
    delete process.env.APP_MODE
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-push-'))
    bodies = []
    __setPushTransportForTests(async (b) => { bodies.push(b); return { status: 200, json: {} } })
    await enablePush()
    app = await buildApp()
    headers = adminHeaders()
  })

  afterEach(() => {
    __setPushTransportForTests(null)
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const push = (id: string, payload: any) =>
    app.inject({ method: 'POST', url: `/admin/users/${id}/push`, headers, payload })

  describe('GET /admin/users/:id devices', () => {
    it('lists devices newest first with hasPush and never the token', async () => {
      const u = await createUser()
      await sql`insert into user_devices (user_id, device_id, platform, last_seen_at)
                values (${u.id}, 'old-web', 'web', now() - interval '1 day')`
      await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at)
                values (${u.id}, 'phone', 'android', 'SECRET-TOKEN-VALUE', now())`
      const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })
      expect(res.statusCode).toBe(200)
      const { devices } = res.json()
      expect(devices.map((d: any) => d.deviceId)).toEqual(['phone', 'old-web'])
      expect(devices[0]).toMatchObject({ platform: 'android', hasPush: true })
      expect(devices[1]).toMatchObject({ platform: 'web', hasPush: false, pushTokenAt: null })
      expect(res.body).not.toContain('SECRET-TOKEN-VALUE')
      expect(res.body).not.toContain('pushToken"')
      expect(res.body).not.toContain('push_token"')
    })

    it('returns an empty list for a user with no devices', async () => {
      const u = await createUser()
      const res = await app.inject({ method: 'GET', url: `/admin/users/${u.id}`, headers })
      expect(res.json().devices).toEqual([])
    })
  })

  describe('POST /admin/users/:id/push', () => {
    it('sends a test push and returns the counts', async () => {
      const u = await createUser()
      await addToken(u.id)
      const res = await push(u.id, { title: ' Hi ', body: 'Hello' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ sent: 1, dead: 0, failed: 0 })
      expect(bodies).toHaveLength(1)
      expect(bodies[0].message.data.type).toBe('test')
      expect(bodies[0].message.data.link).toBe('https://luma.test')
      expect(bodies[0].message.notification).toEqual({ title: 'Hi', body: 'Hello' })
    })

    it.each([
      [{}], [{ title: '', body: 'x' }], [{ title: 'x', body: '   ' }],
      [{ title: 'x'.repeat(101), body: 'x' }], [{ title: 'x', body: 'x'.repeat(501) }],
      [{ title: 5, body: 'x' }],
    ])('400 invalid_push for %j', async (payload) => {
      const u = await createUser()
      await addToken(u.id)
      const res = await push(u.id, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('invalid_push')
    })

    it('accepts the max lengths', async () => {
      const u = await createUser()
      await addToken(u.id)
      const res = await push(u.id, { title: 'x'.repeat(100), body: 'y'.repeat(500) })
      expect(res.statusCode).toBe(200)
    })

    it('409 no_push_device without a token', async () => {
      const u = await createUser()
      const res = await push(u.id, { title: 'a', body: 'b' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('no_push_device')
    })

    it('404 for unknown / malformed user', async () => {
      expect((await push('00000000-0000-0000-0000-000000000000', { title: 'a', body: 'b' })).statusCode).toBe(404)
      expect((await push('nope', { title: 'a', body: 'b' })).statusCode).toBe(404)
    })

    it('503 standby in standby mode', async () => {
      const u = await createUser()
      await addToken(u.id)
      process.env.APP_MODE = 'standby'
      const res = await push(u.id, { title: 'a', body: 'b' })
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('standby')
      expect(bodies).toHaveLength(0)
    })

    it('503 push_not_configured when push is off', async () => {
      const u = await createUser()
      await addToken(u.id)
      delete process.env.FCM_SERVICE_ACCOUNT_FILE
      await initPush()
      const res = await push(u.id, { title: 'a', body: 'b' })
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('push_not_configured')
    })
  })

  describe('POST /admin/users/:id/message with push', () => {
    const msg = (id: string, payload: any) =>
      app.inject({ method: 'POST', url: `/admin/users/${id}/message`, headers, payload })

    it('pushes to a Google-only user with a token (200, no bot)', async () => {
      const u = await createUser({ telegram_id: null, google_sub: 'g-1', email: 'g@x.test' })
      await addToken(u.id)
      const res = await msg(u.id, { text: 'hello', title: 'Team' })
      expect(res.statusCode).toBe(200)
      expect(bodies).toHaveLength(1)
      expect(bodies[0].message.data.type).toBe('admin_message')
      expect(bodies[0].message.notification).toEqual({ title: 'Team', body: 'hello' })
      expect(sendBroadcastMessage).not.toHaveBeenCalled()
    })

    it('400 not_messageable for a Google-only user without a token', async () => {
      const u = await createUser({ telegram_id: null, google_sub: 'g-2', email: 'g2@x.test' })
      const res = await msg(u.id, { text: 'hello' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('not_messageable')
    })

    it('forward to a Google-only user with a token is still not_messageable', async () => {
      const u = await createUser({ telegram_id: null, google_sub: 'g-3', email: 'g3@x.test' })
      await addToken(u.id)
      const res = await msg(u.id, { kind: 'forward', link: 'https://t.me/mychannel/123' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('not_messageable')
      expect(forwardBroadcastMessage).not.toHaveBeenCalled()
    })

    it('Telegram user with a token gets a push, not a DM', async () => {
      const u = await createUser({ telegram_id: 777 })
      await addToken(u.id)
      const res = await msg(u.id, { text: 'hello' })
      expect(res.statusCode).toBe(200)
      expect(bodies).toHaveLength(1)
      expect(sendBroadcastMessage).not.toHaveBeenCalled()
    })

    it('opted-out Telegram user without a token still gets the admin DM', async () => {
      const u = await createUser({ telegram_id: 778, allows_write_to_pm: false })
      const res = await msg(u.id, { text: 'hello' })
      expect(res.statusCode).toBe(200)
      expect(sendBroadcastMessage).toHaveBeenCalledWith(778, 'hello', undefined)
    })
  })
})
