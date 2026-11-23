import { sendWebAppMessage } from '../bot.js'
import { tFor, type Locale } from '../i18n/index.js'
import { canBotDm } from '../messaging/notifyGate.js'

/** Bot DMs for "Ask a friend". Telegram only (the feature lives in the Mini
 *  App); every function is best-effort: logs, never throws, returns whether
 *  the DM went out. The target of an ask is never messaged from here. */

export interface AskDmUser {
  telegram_id: number | null
  allows_write_to_pm?: boolean | null
  locale?: string | null
}

/** WEB_URL with query params; null when WEB_URL is unset (tests, misconfig). */
export function askAppUrl(params: Record<string, string> = {}): string | null {
  const base = process.env.WEB_URL
  if (!base) return null
  try {
    const u = new URL(base)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  } catch {
    return null
  }
}

async function send(u: AskDmUser, text: string, button: string, url: string | null, what: string): Promise<boolean> {
  if (!url || !canBotDm({ telegram_id: u.telegram_id, allows_write_to_pm: u.allows_write_to_pm ?? null })) return false
  try {
    await sendWebAppMessage(u.telegram_id as number, text, button, url)
    return true
  } catch (err) {
    console.error(`[asks] ${what} DM failed:`, (err as Error)?.message ?? err)
    return false
  }
}

const t = (u: AskDmUser) => tFor((u.locale as Locale | null) ?? null)

/** A member friend was asked: "<requester> wants your opinion 👀". */
export function notifyAskMember(u: AskDmUser, requesterName: string, recipientId: string): Promise<boolean> {
  const m = t(u).ask
  return send(u, m.memberRequest(requesterName), m.memberRequestButton,
    askAppUrl({ screen: 'ask', r: recipientId }), 'member request')
}

/** The requester got an answer: "<friend> gave her opinion". */
export function notifyAskAnswered(u: AskDmUser, answererName: string | null, askId: string): Promise<boolean> {
  const m = t(u).ask
  return send(u, m.answered(answererName || m.friendFallbackName), m.answeredButton,
    askAppUrl({ screen: 'ask_result', id: askId }), 'answered')
}

/** Reminder from the requester to an unanswered friend (member or claimed link). */
export function notifyAskRemind(
  u: AskDmUser,
  requesterName: string,
  recipientId: string,
  screen: 'ask' | 'ask_link' = 'ask',
): Promise<boolean> {
  const m = t(u).ask
  return send(u, m.remind(requesterName), m.remindButton,
    askAppUrl({ screen, r: recipientId }), 'remind')
}

/** 3 days after a non-member answered: "try Luma yourself?". */
export function notifyAskNudge(u: AskDmUser): Promise<boolean> {
  const m = t(u).ask
  return send(u, m.nudge, m.nudgeButton, askAppUrl(), 'nudge')
}
