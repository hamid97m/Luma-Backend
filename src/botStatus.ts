import type { Transformer } from 'grammy'
import { sql } from './db.js'

export type BotStatus = 'active' | 'blocked' | 'deactivated' | 'not_started'

/** Save a user's bot reachability; only touches the row (and its timestamp) when it changed.
 *  Never throws — status tracking must not break message delivery. */
export async function recordBotStatus(telegramId: number, status: BotStatus): Promise<void> {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return // seed users have negative ids
  try {
    await sql`
      update users set bot_status = ${status}, bot_status_at = now()
      where telegram_id = ${telegramId} and bot_status is distinct from ${status}`
  } catch (err) {
    console.error('[bot-status] update failed:', (err as Error)?.message ?? err)
  }
}

/** Map a Bot API 403 description to a status; null for anything else (429, 400, …). */
export function botStatusFromError(errorCode: number | undefined, description: string | undefined): BotStatus | null {
  if (errorCode !== 403) return null
  const d = (description ?? '').toLowerCase()
  if (d.includes('deactivated')) return 'deactivated'
  if (d.includes('blocked by the user')) return 'blocked'
  if (d.includes("can't initiate conversation")) return 'not_started'
  return null
}

// Methods that deliver something into the user's private chat.
const SEND_METHODS = /^(send|forward|copy)[A-Z]/

/** grammY API transformer: every outgoing send to a private chat updates that user's
 *  bot status — delivered → active, 403 blocked/deactivated → that status. */
export const botStatusTracker: Transformer = async (prev, method, payload, signal) => {
  const chatId = (payload as { chat_id?: unknown } | undefined)?.chat_id
  if (!SEND_METHODS.test(method) || typeof chatId !== 'number' || chatId <= 0) return prev(method, payload, signal)
  const res = await prev(method, payload, signal) // a network error rethrows: says nothing about the user
  if (res.ok) {
    void recordBotStatus(chatId, 'active')
  } else {
    const status = botStatusFromError(res.error_code, res.description)
    if (status) void recordBotStatus(chatId, status)
  }
  return res
}
