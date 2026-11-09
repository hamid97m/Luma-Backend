import fs from 'node:fs'
import { GoogleAuth } from 'google-auth-library'
import { sql } from '../db.js'
import { isStandby } from '../appMode.js'
import { countPushSent, countPushConfigError } from '../metrics.js'

export type PushType =
  | 'message' | 'gift_message' | 'gift_intro' | 'match' | 'like' | 'like_reveal'
  | 'referral_qualified' | 'referral_reward' | 'premium_purchased' | 'account_paused'
  | 'photo_warning' | 'support_reply' | 'admin_message' | 'purchase_reminder'
  | 'broadcast' | 'test' | 'message_read'

export interface PushPayload {
  type: PushType
  title: string
  body: string
  link: string
  screen?: string
  chatId?: string
  url?: string
  /** Message pushes: unread messages from the sender in that chat, as a string. */
  unread?: string
  /** No `notification` block: the app handles it silently (e.g. message_read
   *  cancels the notification tagged with chatId). title/body are ignored. */
  dataOnly?: boolean
}

export interface PushResult { ok: string[]; dead: string[]; failed: string[] }
export type PushTransport = (body: object) => Promise<{ status: number; json: any }>

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const MAX_IN_FLIGHT = 10
const RETRY_DELAY_MS = 1000

let projectId: string | null = null
let authClient: GoogleAuth | null = null
let transportOverride: PushTransport | null = null

export function __setPushTransportForTests(fn: PushTransport | null): void {
  transportOverride = fn
}

export function isPushConfigured(): boolean {
  return projectId !== null && authClient !== null
}

/** Reads FCM_SERVICE_ACCOUNT_FILE once at boot. Never throws. */
export async function initPush(): Promise<void> {
  projectId = null
  authClient = null
  const keyFile = process.env.FCM_SERVICE_ACCOUNT_FILE?.trim()
  if (!keyFile) {
    console.log('[push] push disabled: FCM_SERVICE_ACCOUNT_FILE not set')
    return
  }
  try {
    const json = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
    if (typeof json.project_id !== 'string' || !json.project_id) throw new Error('no project_id in file')
    authClient = new GoogleAuth({ keyFile, scopes: [SCOPE] })
    projectId = json.project_id
    console.log(`[push] push enabled (project ${projectId})`)
  } catch (err) {
    projectId = null
    authClient = null
    console.log(`[push] push disabled: ${(err as Error).message}`)
  }
}

/** Credential problem (key revoked/broken, token exchange rejected) as opposed
 *  to a network error talking to FCM. Treated like a 401/403: no retry. */
export class PushAuthError extends Error {}

async function defaultTransport(body: object): Promise<{ status: number; json: any }> {
  let client
  try {
    client = await authClient!.getClient()
    const token = await client.getAccessToken()
    if (!token?.token) throw new Error('no access token')
  } catch (err) {
    throw new PushAuthError((err as Error).message)
  }
  const res = await client.request({
    url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    method: 'POST',
    data: body,
    validateStatus: () => true,
  })
  return { status: res.status, json: res.data }
}

function buildBody(token: string, p: PushPayload) {
  const data: Record<string, string> = { type: p.type, link: p.link }
  if (p.screen) data.screen = p.screen
  if (p.chatId) data.chatId = p.chatId
  if (p.url) data.url = p.url
  if (p.unread !== undefined) data.unread = p.unread
  if (p.dataOnly) return { message: { token, android: { priority: 'high' }, data } }
  // Same chat → same tag, so the phone replaces that chat's notification
  // instead of stacking a new one per message.
  const notification: Record<string, string> = { channel_id: 'default', sound: 'default' }
  if (p.chatId) notification.tag = p.chatId
  return {
    message: {
      token,
      notification: { title: p.title, body: p.body },
      android: { priority: 'high', notification },
      data,
    },
  }
}

type Outcome = 'ok' | 'dead' | 'failed' | 'config'

function classify(status: number, json: any): Outcome {
  if (status >= 200 && status < 300) return 'ok'
  const details: any[] = Array.isArray(json?.error?.details) ? json.error.details : []
  // A token minted for another Firebase project: the token is useless to us,
  // our credentials are fine.
  if (status === 403 && details.some((d) => d?.errorCode === 'SENDER_ID_MISMATCH')) return 'dead'
  if (status === 401 || status === 403) return 'config'
  if (status === 404 || details.some((d) => d?.errorCode === 'UNREGISTERED')) return 'dead'
  if (status === 400 && json?.error?.status === 'INVALID_ARGUMENT'
      && String(json?.error?.message ?? '').includes('registration token')) return 'dead'
  return 'failed'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sendOne(token: string, p: PushPayload): Promise<Outcome> {
  const transport = transportOverride ?? defaultTransport
  const body = buildBody(token, p)
  for (let attempt = 0; ; attempt++) {
    try {
      const { status, json } = await transport(body)
      if ((status === 429 || status >= 500) && attempt === 0) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return classify(status, json)
    } catch (err) {
      if (err instanceof PushAuthError) {
        console.error('[push] credential error:', err.message)
        return 'config'
      }
      console.error('[push] transport error:', (err as Error).message)
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return 'failed'
    }
  }
}

export async function sendPushToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { ok: [], dead: [], failed: [] }
  if (tokens.length === 0 || isStandby() || !isPushConfigured()) return result

  let next = 0
  let configError = false
  const worker = async () => {
    while (!configError) {
      const i = next++
      if (i >= tokens.length) return
      const token = tokens[i]
      const outcome = await sendOne(token, payload)
      if (outcome === 'config') {
        if (!configError) {
          configError = true
          countPushConfigError()
          console.error('[push] FCM rejected our credentials (401/403); check FCM_SERVICE_ACCOUNT_FILE / project')
        }
        result.failed.push(token)
        countPushSent(payload.type, 'failed')
        return
      }
      result[outcome].push(token)
      countPushSent(payload.type, outcome)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, tokens.length) }, worker))

  // Config error: everything not yet attempted is failed without sending.
  const seen = new Set([...result.ok, ...result.dead, ...result.failed])
  for (const t of tokens) {
    if (!seen.has(t)) {
      result.failed.push(t)
      countPushSent(payload.type, 'failed')
    }
  }

  if (result.dead.length > 0) {
    await sql`update user_devices set push_token = null, push_token_at = null
              where push_token in ${sql(result.dead)}`
  }
  return result
}

/** A device not seen for this long is treated as inactive: it still gets the
 *  push, but it does not count as delivered (so callers fall back to the bot
 *  DM). Guards against an uninstalled app whose token FCM still accepts. */
export const ACTIVE_DEVICE_DAYS = 14

/** `sent` counts only successful tokens on active devices (seen in the last
 *  ACTIVE_DEVICE_DAYS days); `dead`/`failed` count every token. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; dead: number; failed: number }> {
  const zero = { sent: 0, dead: 0, failed: 0 }
  if (isStandby() || !isPushConfigured()) return zero
  const rows = await sql<{ push_token: string; active: boolean }[]>`
    select push_token,
           last_seen_at > now() - make_interval(days => ${ACTIVE_DEVICE_DAYS}) as active
    from user_devices where user_id = ${userId} and push_token is not null`
  if (rows.length === 0) return zero
  const active = new Set(rows.filter((x) => x.active).map((x) => x.push_token))
  const r = await sendPushToTokens(rows.map((x) => x.push_token), payload)
  return { sent: r.ok.filter((t) => active.has(t)).length, dead: r.dead.length, failed: r.failed.length }
}
