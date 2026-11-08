import type { IncomingHttpHeaders } from 'node:http'

export type ClientPlatform = 'telegram' | 'web' | 'android'

export interface ClientInfo {
  deviceId: string
  platform: ClientPlatform
  appVersion: string | null
  deviceModel: string | null
  os: string | null
  userAgent: string | null
}

const PLATFORMS: readonly string[] = ['telegram', 'web', 'android']

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Strip control characters, trim, truncate; empty → null. */
function clean(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const out = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max).trim()
  return out || null
}

/** Reads the X-Client-* / X-Device-* headers. Never throws; null when there is no usable device id. */
export function parseClientInfo(headers: IncomingHttpHeaders, authKind: 'initData' | 'bearer'): ClientInfo | null {
  const deviceId = clean(header(headers, 'x-device-id'), 64)
  if (!deviceId) return null
  const raw = clean(header(headers, 'x-client-platform'), 32)?.toLowerCase()
  const platform = (raw && PLATFORMS.includes(raw) ? raw : authKind === 'initData' ? 'telegram' : 'web') as ClientPlatform
  return {
    deviceId,
    platform,
    appVersion: clean(header(headers, 'x-client-version'), 32),
    deviceModel: clean(header(headers, 'x-device-model'), 64),
    os: clean(header(headers, 'x-device-os'), 64),
    userAgent: clean(header(headers, 'user-agent'), 256),
  }
}
