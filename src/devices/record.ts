import { sql } from '../db.js'
import type { ClientInfo } from './clientInfo.js'

const THROTTLE_MS = 5 * 60_000
const MAX_ENTRIES = 10_000
const lastWrite = new Map<string, number>()

export async function upsertDevice(userId: string, info: ClientInfo): Promise<void> {
  await sql`
    insert into user_devices (user_id, device_id, platform, app_version, device_model, os, user_agent)
    values (${userId}, ${info.deviceId}, ${info.platform}, ${info.appVersion}, ${info.deviceModel}, ${info.os}, ${info.userAgent})
    on conflict (user_id, device_id) do update set
      platform = excluded.platform, app_version = coalesce(excluded.app_version, user_devices.app_version),
      device_model = coalesce(excluded.device_model, user_devices.device_model),
      os = coalesce(excluded.os, user_devices.os),
      user_agent = coalesce(excluded.user_agent, user_devices.user_agent), last_seen_at = now()`
}

/** Fire-and-forget, at most one upsert per user+device per 5 minutes. Never throws. */
export function recordDevice(userId: string, info: ClientInfo | null, log: { warn: (...a: any[]) => void }): void {
  if (!info) return
  const key = `${userId}:${info.deviceId}`
  const now = Date.now()
  const prev = lastWrite.get(key)
  if (prev !== undefined && now - prev < THROTTLE_MS) return
  lastWrite.delete(key) // re-insert so Map order stays oldest-first
  lastWrite.set(key, now)
  while (lastWrite.size > MAX_ENTRIES) {
    const oldest = lastWrite.keys().next().value
    if (oldest === undefined) break
    lastWrite.delete(oldest)
  }
  upsertDevice(userId, info).catch((err) => {
    lastWrite.delete(key)
    log.warn({ err }, 'failed to record device')
  })
}

export function resetDeviceThrottle(): void {
  lastWrite.clear()
}
