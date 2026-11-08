import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { initPush, __setPushTransportForTests } from '../src/push/fcm.js'

vi.mock('../src/bot.js', () => ({
  sendBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  forwardBroadcastMessage: vi.fn().mockResolvedValue(undefined),
  verifyForwardSource: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/messaging/broadcast.js', async (orig) => ({
  ...(await orig<typeof import('../src/messaging/broadcast.js')>()),
  runBroadcast: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))
// Another area's module (purchase-message job) — mocked, not exercised here.
vi.mock('../src/jobs/purchaseMessageConfig.js', () => ({
  getPurchaseMessageConfig: vi.fn(),
  updatePurchaseMessageConfig: vi.fn(),
}))

import { buildApp } from '../src/server.js'
import { verifyForwardSource, sendBroadcastMessage } from '../src/bot.js'
import { runBroadcast, cleanupInterruptedBroadcasts } from '../src/messaging/broadcast.js'
import { getPurchaseMessageConfig, updatePurchaseMessageConfig } from '../src/jobs/purchaseMessageConfig.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'
import { createAdmin } from './helpers/admin.js'
import { failOn, clearFailures } from './helpers/bot-support.js'

const BROADCAST_ROW = {
  message: 'hello', filters: {}, status: 'running',
  total_recipients: 3, sent_count: 0, failed_count: 0,
  created_at: '2026-09-01T00:00:00.000Z', created_by_username: 'root',
}

/** Wait for the fire-and-forget executeBroadcast to settle. */
async function settled(id: string, status = 'completed') {
  for (let i = 0; i < 50; i++) {
    const [row] = await sql`select status from broadcasts where id = ${id}`
    if (row?.status === status) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`broadcast ${id} never reached ${status}`)
}

describe('admin broadcasts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let admin: { id: string }

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    ;({ admin, headers } = await createAdmin())
  })
  afterEach(clearFailures)

  it('POST /admin/broadcasts/preview returns the audience count', async () => {
    await createUser({ gender: 'woman', looking_for: 'men' })
    await createUser({ gender: 'woman', looking_for: 'men' })
    await createUser({ gender: 'man' })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: { filters: { genders: ['woman'] } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 2 })
  })

  it('POST /admin/broadcasts/preview with no filters counts the whole baseline audience', async () => {
    await createUser()
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: {} })
    expect(res.json()).toEqual({ count: 1 })
  })

  it('POST /admin/broadcasts rejects an empty message', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: '   ', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
  })

  it('POST /admin/broadcasts rejects a message over 4096 chars', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'x'.repeat(4097), filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('message_too_long')
  })

  it('POST /admin/broadcasts rejects an empty audience', async () => {
    await createUser({ is_seed: true }) // excluded by the baseline guards
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_audience')
    expect(await sql`select id from broadcasts`).toHaveLength(0)
  })

  it('POST /admin/broadcasts creates a job row, runs it, and records the totals', async () => {
    const u0 = await createUser()
    const u1 = await createUser()
    vi.mocked(runBroadcast).mockImplementationOnce(async (targets, opts) => {
      await opts.onProgress({ sent: 1, failed: 0 })
      await opts.onOptOut(u1.id)
      return { sent: 1, failed: 1 }
    })
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: ' hello ', filters: {} } })
    expect(res.statusCode).toBe(200)
    const b = res.json().broadcast
    expect(b).toMatchObject({
      kind: 'text', message: 'hello', filters: {}, status: 'running', totalRecipients: 2,
      sentCount: 0, failedCount: 0, finishedAt: null, error: null, createdByUsername: 'root',
    })
    const targets = vi.mocked(runBroadcast).mock.calls[0][0]
    expect(targets.map((t) => t.id).sort()).toEqual([u0.id, u1.id].sort())

    await settled(b.id)
    const [row] = await sql`select * from broadcasts where id = ${b.id}`
    expect(row).toMatchObject({ created_by: admin.id, status: 'completed', sent_count: 1, failed_count: 1 })
    expect(row.finished_at).not.toBeNull()
    const [optedOut] = await sql`select allows_write_to_pm from users where id = ${u1.id}`
    expect(optedOut.allows_write_to_pm).toBe(false)

    // Delivery closure sends the composed text to the target.
    await vi.mocked(runBroadcast).mock.calls[0][1].send({ id: u0.id, telegram_id: 42 })
    expect(sendBroadcastMessage).toHaveBeenCalledWith(42, 'hello', undefined)
  })

  it('stores the filters as jsonb', async () => {
    await createUser({ gender: 'woman', looking_for: 'men', locale: 'en' })
    const filters = { genders: ['woman'], locales: ['en'], activity: { activeWithinDays: 7 } }
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters } })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast.filters).toEqual(filters)
    const [row] = await sql`select filters, jsonb_typeof(filters) as t from broadcasts`
    expect(row).toEqual({ filters, t: 'object' })
  })

  it('marks the job failed when the send loop throws', async () => {
    await createUser()
    vi.mocked(runBroadcast).mockRejectedValueOnce(new Error('loop exploded'))
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {} } })
    const id = res.json().broadcast.id
    await settled(id, 'failed')
    const [row] = await sql`select status, error, finished_at from broadcasts where id = ${id}`
    expect(row).toMatchObject({ status: 'failed', error: 'loop exploded' })
  })

  it('500 broadcast_create_failed when the job insert fails', async () => {
    await createUser()
    await failOn('broadcasts', 'insert')
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {} } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'broadcast_create_failed' })
    expect(runBroadcast).not.toHaveBeenCalled()
  })

  it('GET /admin/broadcasts lists jobs newest first', async () => {
    await insertRow('broadcasts', { ...BROADCAST_ROW, message: 'old', created_at: '2026-08-01T00:00:00.000Z' })
    await insertRow('broadcasts', { ...BROADCAST_ROW })
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
    expect(res.json().items[0]).toMatchObject({ message: 'hello', createdByUsername: 'root', createdAt: '2026-09-01T00:00:00.000Z' })
  })

  it('GET /admin/broadcasts/:id returns one job', async () => {
    const b = await insertRow('broadcasts', BROADCAST_ROW)
    const res = await app.inject({ method: 'GET', url: `/admin/broadcasts/${b.id}`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast).toMatchObject({ id: b.id, status: 'running', totalRecipients: 3 })
  })

  it('GET /admin/broadcasts/:id 404s an unknown or malformed id', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/admin/broadcasts/00000000-0000-0000-0000-000000000000', headers })
    expect(r1.statusCode).toBe(404)
    expect(r1.json()).toEqual({ error: 'broadcast_not_found' })
    const r2 = await app.inject({ method: 'GET', url: '/admin/broadcasts/b1', headers })
    expect(r2.statusCode).toBe(404)
  })

  it('POST /admin/broadcasts (forward) rejects an invalid link', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'not a link', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_link')
  })

  it('POST /admin/broadcasts (forward) 400s when the source is unreachable', async () => {
    vi.mocked(verifyForwardSource).mockRejectedValueOnce(
      Object.assign(new Error('Bad Request: message to forward not found'), { description: 'Bad Request: message to forward not found' }),
    )
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123', filters: {} } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('forward_source_unreachable')
  })

  it('POST /admin/broadcasts (forward) creates a forward job row', async () => {
    await createUser()
    await createUser()
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { kind: 'forward', link: 'https://t.me/mychannel/123', filters: {} } })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast).toMatchObject({ kind: 'forward', message: 'https://t.me/mychannel/123', totalRecipients: 2 })
    expect(verifyForwardSource).toHaveBeenCalledWith('@mychannel', 123)
    const [row] = await sql`select source_chat_id, source_message_id from broadcasts`
    expect(row).toEqual({ source_chat_id: '@mychannel', source_message_id: 123 })
  })

  it('POST /admin/broadcasts rejects an invalid button', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload: { message: 'hi', filters: {}, button: { title: 'Go', kind: 'url', url: 'bad' } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('button_url_invalid')
  })

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts' })
    expect(res.statusCode).toBe(401)
  })

  // --- Abandoned-checkout auto-message config ---

  const PURCHASE_CFG = {
    enabled: true, kind: 'text' as const, message: 'come back', button: null,
    sourceChatId: null, sourceMessageId: null, activeSince: '2026-09-09T00:00:00Z', translations: {},
  }
  async function seedSends(n: number) {
    for (let i = 0; i < n; i++) await insertRow('purchase_message_sends', { user_id: (await createUser()).id })
  }

  it('GET /admin/broadcasts/purchase-message returns config + sent count', async () => {
    vi.mocked(getPurchaseMessageConfig).mockResolvedValue(PURCHASE_CFG)
    await seedSends(5)
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts/purchase-message', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.enabled).toBe(true)
    expect(res.json().config.sentCount).toBe(5)
  })

  it('GET purchase-message falls back to defaults when unconfigured', async () => {
    vi.mocked(getPurchaseMessageConfig).mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/admin/broadcasts/purchase-message', headers })
    expect(res.json().config).toEqual({
      enabled: false, kind: 'text', message: '', button: null, translations: {}, activeSince: null, sentCount: 0,
    })
  })

  it('PUT /admin/broadcasts/purchase-message saves a text message', async () => {
    vi.mocked(updatePurchaseMessageConfig).mockImplementation(async (p: any) => ({ ...PURCHASE_CFG, ...p }))
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'text', message: 'come back' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.kind).toBe('text')
  })

  it('PUT purchase-message saves translations (text) and clears them (forward)', async () => {
    vi.mocked(updatePurchaseMessageConfig).mockImplementation(async (p: any) => ({ ...PURCHASE_CFG, ...p }))
    const translations = { en: { message: 'Come back!', buttonTitle: 'Plans' } }
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: true, kind: 'text', message: 'come back', translations } })
    expect(res.statusCode).toBe(200)
    expect((vi.mocked(updatePurchaseMessageConfig).mock.calls[0][0] as any).translations).toEqual(translations)
    expect(res.json().config.translations).toEqual(translations)

    const fwd = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: false, kind: 'forward', link: 'https://t.me/mychannel/9' } })
    expect(fwd.statusCode).toBe(200)
    expect((vi.mocked(updatePurchaseMessageConfig).mock.calls[1][0] as any).translations).toEqual({})
  })

  it('PUT purchase-message 500s when the update fails', async () => {
    vi.mocked(updatePurchaseMessageConfig).mockResolvedValue(null)
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'text', message: 'x' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'purchase_message_update_failed' })
  })

  it('PUT purchase-message rejects malformed translations', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers,
      payload: { enabled: true, kind: 'text', message: 'come back', translations: { de: { message: 'x' } } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_translations')
  })

  it('PUT purchase-message rejects an empty message when enabled', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'text', message: '  ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('empty_message')
  })

  it('PUT purchase-message rejects an invalid forward link', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'forward', link: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_link')
  })

  it('PUT purchase-message 400s when the forward source is unreachable', async () => {
    vi.mocked(verifyForwardSource).mockRejectedValueOnce(
      Object.assign(new Error('Bad Request: chat not found'), { description: 'Bad Request: chat not found' }),
    )
    const res = await app.inject({ method: 'PUT', url: '/admin/broadcasts/purchase-message', headers, payload: { enabled: true, kind: 'forward', link: 'https://t.me/mychannel/9' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('forward_source_unreachable')
  })
})

describe('admin push broadcasts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>
  let tmp: string
  let bodies: any[]
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    ;({ headers } = await createAdmin())
    for (const k of ['FCM_SERVICE_ACCOUNT_FILE', 'APP_MODE', 'WEB_URL']) savedEnv[k] = process.env[k]
    delete process.env.APP_MODE
    process.env.WEB_URL = 'https://app.example.com'
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-push-'))
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
    __setPushTransportForTests(async (body) => { bodies.push(body); return { status: 200, json: {} } })
  })
  afterEach(() => {
    __setPushTransportForTests(null)
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function withToken(overrides: Record<string, unknown> = {}) {
    const u = await createUser(overrides)
    await sql`insert into user_devices (user_id, device_id, platform, push_token) values (${u.id}, ${'d-' + u.id}, 'android', ${'tok-' + u.id})`
    return u
  }
  const post = (payload: any) => app.inject({ method: 'POST', url: '/admin/broadcasts', headers, payload })

  it('sends a push broadcast to users with tokens and records channel/title', async () => {
    await withToken(); await withToken(); await createUser()
    vi.mocked(runBroadcast).mockImplementationOnce(async (t, o) =>
      (await vi.importActual<typeof import('../src/messaging/broadcast.js')>('../src/messaging/broadcast.js'))
        .runBroadcast(t, { ...o, sleep: async () => {} }))
    const res = await post({ channel: 'push', title: 'Hello', message: 'Body', filters: {}, button: { title: 'Go', kind: 'screen', screen: 'plans' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().broadcast).toMatchObject({ kind: 'push', channel: 'push', title: 'Hello', message: 'Body', totalRecipients: 2 })
    await settled(res.json().broadcast.id)
    const [row] = await sql`select * from broadcasts`
    expect(row).toMatchObject({ status: 'completed', sent_count: 2, failed_count: 0, channel: 'push', kind: 'push' })
    expect(bodies).toHaveLength(2)
    expect(bodies[0].message.notification).toEqual({ title: 'Hello', body: 'Body' })
    expect(bodies[0].message.data).toMatchObject({ type: 'broadcast', screen: 'plans' })
    expect(sendBroadcastMessage).not.toHaveBeenCalled()
  })

  it('validates push title, message and kind', async () => {
    await withToken()
    expect((await post({ channel: 'push', message: 'x' })).json().error).toBe('empty_title')
    expect((await post({ channel: 'push', title: 'x'.repeat(101), message: 'x' })).json().error).toBe('title_too_long')
    expect((await post({ channel: 'push', title: 't', message: ' ' })).json().error).toBe('empty_message')
    expect((await post({ channel: 'push', title: 't', message: 'x'.repeat(501) })).json().error).toBe('message_too_long')
    const fwd = await post({ channel: 'push', kind: 'forward', title: 't', link: 'https://t.me/c/1' })
    expect(fwd.statusCode).toBe(400)
    expect(fwd.json().error).toBe('push_forward_unsupported')
    expect((await post({ channel: 'smoke', message: 'x' })).json().error).toBe('invalid_channel')
  })

  it('push preview counts users with tokens; empty push audience is rejected', async () => {
    const empty = await post({ channel: 'push', title: 't', message: 'm' })
    expect(empty.json().error).toBe('empty_audience')
    await withToken(); await createUser()
    const res = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: { channel: 'push' } })
    expect(res.json()).toEqual({ count: 1 })
  })

  it('push broadcast and preview are 503 standby in standby mode', async () => {
    await withToken()
    process.env.APP_MODE = 'standby'
    const res = await post({ channel: 'push', title: 't', message: 'm' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'standby' })
    const pre = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: { channel: 'push' } })
    expect(pre.statusCode).toBe(503)
    expect(pre.json()).toEqual({ error: 'standby' })
    expect(await sql`select id from broadcasts`).toHaveLength(0)
  })

  it('push broadcast and preview are 503 push_not_configured without an FCM key', async () => {
    await withToken()
    delete process.env.FCM_SERVICE_ACCOUNT_FILE
    await initPush()
    const res = await post({ channel: 'push', title: 't', message: 'm' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'push_not_configured' })
    const pre = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: { channel: 'push' } })
    expect(pre.statusCode).toBe(503)
    expect(pre.json()).toEqual({ error: 'push_not_configured' })
    expect(await sql`select id from broadcasts`).toHaveLength(0)
    // bot-channel preview is unaffected
    const bot = await app.inject({ method: 'POST', url: '/admin/broadcasts/preview', headers, payload: {} })
    expect(bot.statusCode).toBe(200)
  })

  it('GET list and detail include channel and title', async () => {
    const b = await insertRow('broadcasts', { ...BROADCAST_ROW, kind: 'push', channel: 'push', title: 'T' })
    const list = await app.inject({ method: 'GET', url: '/admin/broadcasts', headers })
    expect(list.json().items[0]).toMatchObject({ channel: 'push', title: 'T' })
    const one = await app.inject({ method: 'GET', url: `/admin/broadcasts/${b.id}`, headers })
    expect(one.json().broadcast).toMatchObject({ channel: 'push', title: 'T' })
  })
})

describe('cleanupInterruptedBroadcasts', () => {
  beforeEach(resetDb)

  it("marks only 'running' broadcasts interrupted", async () => {
    const running = await insertRow('broadcasts', BROADCAST_ROW)
    const done = await insertRow('broadcasts', { ...BROADCAST_ROW, status: 'completed' })
    await cleanupInterruptedBroadcasts('2026-09-02T00:00:00.000Z')
    const rows = await sql`select id, status, finished_at from broadcasts`
    expect(rows.find((r) => r.id === running.id)).toMatchObject({ status: 'interrupted', finished_at: '2026-09-02T00:00:00.000Z' })
    expect(rows.find((r) => r.id === done.id)).toMatchObject({ status: 'completed', finished_at: null })
  })
})
