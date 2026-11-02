import type { Transformer } from 'grammy'

/**
 * APP_MODE=standby runs the HTTP API only: no Telegram webhook registration, no
 * scheduled jobs, and no outbound bot calls that reach users or change the bot.
 * Used for a second server (staging, or a replacement being prepared) while another deployment owns
 * the bot. Anything else (unset, "live") is normal operation.
 */
export function isStandby(): boolean {
  return process.env.APP_MODE === 'standby'
}

/** Read-only / no-user-impact Bot API methods still allowed in standby
 *  (onboarding photo import, gift catalog, invoice links for checkout tests). */
export const STANDBY_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'getMe',
  'getFile',
  'getUserProfilePhotos',
  'getAvailableGifts',
  'getMyStarBalance',
  'createInvoiceLink',
])

/** grammY API transformer: in standby, refuse every method not on the allowlist
 *  before it leaves the process. */
export const standbyBotGuard: Transformer = (prev, method, payload, signal) => {
  if (!STANDBY_ALLOWED_METHODS.has(method)) {
    console.warn(`[standby] blocked Bot API call: ${method}`)
    return Promise.resolve({
      ok: false,
      error_code: 503,
      description: `APP_MODE=standby: ${method} is disabled`,
    } as never)
  }
  return prev(method, payload, signal)
}
