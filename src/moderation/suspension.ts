import { getBotUsername } from '../bot.js'

/** 401 body for a temporarily suspended account (AI report review) — the
 *  banned body's extras (botUsername for the support deep link) plus the end date. */
export function suspendedBody(until: Date | string): { error: 'suspended'; suspendedUntil: string; botUsername: string | null } {
  return { error: 'suspended', suspendedUntil: new Date(until).toISOString(), botUsername: getBotUsername() }
}

/** True while a suspended_until value is still in the future. */
export function isSuspended(until: Date | string | null | undefined, now = Date.now()): boolean {
  return Boolean(until) && new Date(until as string).getTime() > now
}
