import { sql } from '../db.js'
import type { ClientInfo } from './clientInfo.js'

/** Registers an FCM token for this device. A token belongs to one row only: it is cleared everywhere else first. */
export async function setPushToken(userId: string, info: ClientInfo, token: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update user_devices set push_token = null, push_token_at = null
      where push_token = ${token} and not (user_id = ${userId} and device_id = ${info.deviceId})`
    await tx`
      insert into user_devices (user_id, device_id, platform, app_version, device_model, os, user_agent, push_token, push_token_at)
      values (${userId}, ${info.deviceId}, ${info.platform}, ${info.appVersion}, ${info.deviceModel}, ${info.os}, ${info.userAgent}, ${token}, now())
      on conflict (user_id, device_id) do update set
        platform = excluded.platform, app_version = excluded.app_version,
        device_model = coalesce(excluded.device_model, user_devices.device_model),
        os = coalesce(excluded.os, user_devices.os),
        user_agent = excluded.user_agent, last_seen_at = now(),
        push_token = excluded.push_token, push_token_at = now()`
  })
}

export async function clearPushToken(userId: string, deviceId: string): Promise<void> {
  await sql`
    update user_devices set push_token = null, push_token_at = null
    where user_id = ${userId} and device_id = ${deviceId}`
}
