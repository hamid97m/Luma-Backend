import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/bot.js', () => ({ notifyMatch: vi.fn(), notifyNewMessage: vi.fn().mockResolvedValue(undefined) }))

import { buildApp } from '../src/server.js'
import { initPush, __setPushTransportForTests } from '../src/push/fcm.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, createMatch, insertRow, sql } from './helpers/db.js'

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
let other: Record<string, any>
let match: Record<string, any>
let tmp: string
let bodies: any[]
const envKeys = ['FCM_SERVICE_ACCOUNT_FILE', 'APP_MODE', 'WEB_URL'] as const
const saved: Record<string, string | undefined> = {}

const settle = () => new Promise((r) => setTimeout(r, 100))

beforeEach(async () => {
  for (const k of envKeys) saved[k] = process.env[k]
  process.env.WEB_URL = 'https://luma.test'
  delete process.env.APP_MODE
  await resetDb()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-push-'))
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
  bodies = []
  __setPushTransportForTests(async (b) => { bodies.push(b); return { status: 200, json: {} } })

  app = await buildApp()
  me = await createUser({ name: 'Ali', gender: 'woman', looking_for: 'men' })
  other = await createUser({ name: 'Sara' })
  match = await createMatch(me.id, other.id)
  authAs(me)
})

afterEach(async () => {
  __setPushTransportForTests(null)
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  await initPush()
})

async function addToken(userId: string, token = 'tok-' + userId) {
  await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at)
            values (${userId}, ${'d-' + token}, 'android', ${token}, now())`
}
const read = () => app.inject({ method: 'POST', url: `/matches/${match.id}/read`, headers: AUTH })
const unreadFromOther = () => insertRow('messages', { match_id: match.id, sender_id: other.id, body: 'hi' })

describe('message_read push (clear the chat notification on read)', () => {
  it('POST /read sends exactly one data-only message_read push to the reader', async () => {
    await addToken(me.id)
    await addToken(other.id)
    await unreadFromOther()
    const res = await read()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    await settle()
    expect(bodies).toHaveLength(1)
    const msg = bodies[0].message
    expect(msg.token).toBe('tok-' + me.id)
    expect('notification' in msg).toBe(false)
    expect(msg.android).toEqual({ priority: 'high' })
    expect(msg.data).toEqual({
      type: 'message_read', chatId: match.id, link: `https://luma.test/?screen=matches&chat=${match.id}`,
    })
  })

  it('sends nothing when the reader has no push token; the response is unchanged', async () => {
    await unreadFromOther()
    const res = await read()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await settle()
    expect(bodies).toHaveLength(0)
  })

  it('sends nothing when there was nothing unread to mark', async () => {
    await addToken(me.id)
    await insertRow('messages', { match_id: match.id, sender_id: other.id, body: 'hi', read_at: new Date().toISOString() })
    await read()
    await settle()
    expect(bodies).toHaveLength(0)
  })

  it('opening the chat (GET messages marks read) also sends the clear push', async () => {
    await addToken(me.id)
    await unreadFromOther()
    const res = await app.inject({ method: 'GET', url: `/matches/${match.id}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].message.data.type).toBe('message_read')
  })

  it('a failing push never affects the read response', async () => {
    await addToken(me.id)
    await unreadFromOther()
    __setPushTransportForTests(async () => ({ status: 400, json: {} }))
    const res = await read()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
