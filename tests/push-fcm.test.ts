import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { resetDb, createUser, sql } from './helpers/db.js'
import {
  initPush, isPushConfigured, sendPushToTokens, sendPushToUser, __setPushTransportForTests, PushAuthError,
  type PushPayload,
} from '../src/push/fcm.js'
import { registry } from '../src/metrics.js'

const payload: PushPayload = {
  type: 'message', title: 'Sara', body: 'hi', link: 'https://app.test/?screen=matches&chat=c1',
  screen: 'matches', chatId: 'c1',
}

let tmp: string
let keyFile: string
const envKeys = ['FCM_SERVICE_ACCOUNT_FILE', 'APP_MODE'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(async () => {
  for (const k of envKeys) saved[k] = process.env[k]
  await resetDb()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-test-'))
  keyFile = path.join(tmp, 'sa.json')
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
  delete process.env.APP_MODE
  await initPush()
})

afterEach(() => {
  __setPushTransportForTests(null)
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function addToken(token: string) {
  const u = await createUser()
  await sql`insert into user_devices (user_id, device_id, platform, push_token, push_token_at)
            values (${u.id}, ${'d-' + token}, 'android', ${token}, now())`
  return u
}
const tokenOf = async (t: string) =>
  (await sql`select push_token from user_devices where device_id = ${'d-' + t}`)[0].push_token

describe('initPush', () => {
  it('is configured with a valid key file', () => {
    expect(isPushConfigured()).toBe(true)
  })

  it('resolves and stays disabled for a missing file', async () => {
    process.env.FCM_SERVICE_ACCOUNT_FILE = path.join(tmp, 'nope.json')
    await expect(initPush()).resolves.toBeUndefined()
    expect(isPushConfigured()).toBe(false)
  })
})

describe('sendPushToTokens', () => {
  it('sends the spec shape with string-only data', async () => {
    const bodies: any[] = []
    __setPushTransportForTests(async (b) => { bodies.push(b); return { status: 200, json: {} } })
    const r = await sendPushToTokens(['t1'], payload)
    expect(r).toEqual({ ok: ['t1'], dead: [], failed: [] })
    expect(bodies[0]).toEqual({
      message: {
        token: 't1',
        notification: { title: 'Sara', body: 'hi' },
        android: { priority: 'high', notification: { channel_id: 'default', sound: 'default' } },
        data: { type: 'message', link: payload.link, screen: 'matches', chatId: 'c1' },
      },
    })
    for (const v of Object.values(bodies[0].message.data)) expect(typeof v).toBe('string')
  })

  it('a 404 token is nulled in user_devices', async () => {
    await addToken('dead1')
    await addToken('live1')
    __setPushTransportForTests(async (b: any) =>
      b.message.token === 'dead1'
        ? { status: 404, json: { error: { details: [{ errorCode: 'UNREGISTERED' }] } } }
        : { status: 200, json: {} })
    const r = await sendPushToTokens(['dead1', 'live1'], payload)
    expect(r).toEqual({ ok: ['live1'], dead: ['dead1'], failed: [] })
    expect(await tokenOf('dead1')).toBeNull()
    expect(await tokenOf('live1')).toBe('live1')
  })

  it('400 INVALID_ARGUMENT about the registration token is dead; other 400 is failed and kept', async () => {
    await addToken('bad-tok')
    await addToken('bad-payload')
    __setPushTransportForTests(async (b: any) => ({
      status: 400,
      json: { error: { status: 'INVALID_ARGUMENT', message: b.message.token === 'bad-tok'
        ? 'The registration token is not a valid FCM registration token' : 'Invalid value at data' } },
    }))
    const r = await sendPushToTokens(['bad-tok', 'bad-payload'], payload)
    expect(r.dead).toEqual(['bad-tok'])
    expect(r.failed).toEqual(['bad-payload'])
    expect(await tokenOf('bad-tok')).toBeNull()
    expect(await tokenOf('bad-payload')).toBe('bad-payload')
  })

  it('retries a 503 once and succeeds', async () => {
    let calls = 0
    __setPushTransportForTests(async () => (++calls === 1 ? { status: 503, json: {} } : { status: 200, json: {} }))
    const r = await sendPushToTokens(['t1'], payload)
    expect(r.ok).toEqual(['t1'])
    expect(calls).toBe(2)
  })

  it('a persistent 5xx ends failed after one retry', async () => {
    let calls = 0
    __setPushTransportForTests(async () => { calls++; return { status: 500, json: {} } })
    const r = await sendPushToTokens(['t1'], payload)
    expect(r.failed).toEqual(['t1'])
    expect(calls).toBe(2)
  })

  it('a 401 stops the batch and counts a config error', async () => {
    let calls = 0
    __setPushTransportForTests(async () => { calls++; return { status: 401, json: {} } })
    const before = await registry.getSingleMetricAsString('luma_push_config_errors_total')
    const tokens = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const r = await sendPushToTokens(tokens, payload)
    expect(r.ok).toEqual([])
    expect(r.failed.sort()).toEqual([...tokens].sort())
    expect(calls).toBeLessThan(30)
    const after = await registry.getSingleMetricAsString('luma_push_config_errors_total')
    expect(after).not.toBe(before)
    expect(after).toMatch(/luma_push_config_errors_total \d+/)
  })

  it('a credential error from token acquisition stops the batch without retry', async () => {
    let calls = 0
    __setPushTransportForTests(async () => { calls++; throw new PushAuthError('invalid_grant') })
    const tokens = Array.from({ length: 30 }, (_, i) => `a${i}`)
    for (const t of tokens) await addToken(t)
    const count = async () => Number(
      (await registry.getSingleMetricAsString('luma_push_config_errors_total')).match(/luma_push_config_errors_total (\d+)/)?.[1] ?? 0)
    const before = await count()
    const r = await sendPushToTokens(tokens, payload)
    expect(await count()).toBe(before + 1)
    expect(calls).toBeLessThanOrEqual(10)
    expect(r.ok).toEqual([])
    expect(r.dead).toEqual([])
    expect([...r.failed].sort()).toEqual([...tokens].sort())
    const kept = await sql`select count(*)::int as n from user_devices where push_token is not null`
    expect(kept[0].n).toBe(30)
  })

  it('does nothing in standby', async () => {
    process.env.APP_MODE = 'standby'
    const t = vi.fn(async () => ({ status: 200, json: {} }))
    __setPushTransportForTests(t)
    const r = await sendPushToTokens(['t1'], payload)
    expect(r).toEqual({ ok: [], dead: [], failed: [] })
    expect(t).not.toHaveBeenCalled()
  })
})

describe('sendPushToUser', () => {
  it('sends to the user tokens', async () => {
    const u = await addToken('u1')
    __setPushTransportForTests(async () => ({ status: 200, json: {} }))
    expect(await sendPushToUser(u.id, payload)).toEqual({ sent: 1, dead: 0, failed: 0 })
  })

  it('returns zeros when unconfigured', async () => {
    const u = await addToken('u1')
    delete process.env.FCM_SERVICE_ACCOUNT_FILE
    await initPush()
    const t = vi.fn(async () => ({ status: 200, json: {} }))
    __setPushTransportForTests(t)
    expect(await sendPushToUser(u.id, payload)).toEqual({ sent: 0, dead: 0, failed: 0 })
    expect(t).not.toHaveBeenCalled()
  })

  it('returns zeros in standby and for a user without tokens', async () => {
    const u = await addToken('u1')
    const nobody = await createUser()
    const t = vi.fn(async () => ({ status: 200, json: {} }))
    __setPushTransportForTests(t)
    expect(await sendPushToUser(nobody.id, payload)).toEqual({ sent: 0, dead: 0, failed: 0 })
    process.env.APP_MODE = 'standby'
    expect(await sendPushToUser(u.id, payload)).toEqual({ sent: 0, dead: 0, failed: 0 })
    expect(t).not.toHaveBeenCalled()
  })
})
