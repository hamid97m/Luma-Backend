import { notifyMatch, notifyNewLike } from '../bot.js'
import { sendPushToUser, isPushConfigured, type PushPayload } from '../push/fcm.js'
import { isStandby } from '../appMode.js'
import { linkFields } from '../push/links.js'
import { canBotDm } from '../messaging/notifyGate.js'
import { tFor, type Locale } from '../i18n/index.js'

/** Recipient of a user-facing notification (push first, bot DM fallback). */
export interface NotifyUser {
  id: string
  telegram_id: number | null
  allows_write_to_pm: boolean | null
  locale: string | null
}

/** Push bodies are plain text: drop any Telegram HTML tags from DM strings. */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

/**
 * Channel choice for one notification. Push first; the bot DM goes out only
 * when no push was delivered (no tokens, all dead/failed, push disabled) and
 * the user can receive bot DMs. A failing push (e.g. DB error pruning dead
 * tokens) is logged and counts as zero sent. Bot errors are rethrown so
 * callers keep their own 403 handling.
 */
export async function deliverToUser(
  u: NotifyUser,
  push: PushPayload,
  botSend: () => Promise<void>,
): Promise<'push' | 'bot' | 'none'> {
  let sent = 0
  // Checked here too (sendPushToUser also does) so that with push off the bot
  // DM starts in the same tick as before push existed — no extra awaits.
  if (isPushConfigured() && !isStandby()) {
    try {
      sent = (await sendPushToUser(u.id, push)).sent
    } catch (err) {
      console.error(`[notify] push to ${u.id} failed:`, (err as Error)?.message ?? err)
    }
  }
  if (sent > 0) return 'push'
  if (!canBotDm(u)) return 'none'
  await botSend()
  return 'bot'
}

/** linkFields that never throws: with WEB_URL unset (tests, misconfig) the
 * link is empty but screen/chatId still let the app route. */
export function safeLinkFields(opts: { screen?: string; chat?: string } = {}): ReturnType<typeof linkFields> {
  try {
    return linkFields(opts)
  } catch {
    const out: ReturnType<typeof linkFields> = { link: '' }
    if (opts.screen) out.screen = opts.screen
    if (opts.chat) out.chatId = opts.chat
    return out
  }
}

const localeOf = (u: NotifyUser) => (u.locale as Locale | null) ?? null

/** "It's a match" for one user. Never throws (logs). */
export async function notifyUserMatch(
  u: NotifyUser,
  m: { matchName: string; matchPhoto: string | null; question?: string | null; matchId?: string },
): Promise<void> {
  try {
    const t = tFor(localeOf(u))
    const body = m.question ? t.notify.matchWithQuestion(m.matchName, m.question) : t.notify.match(m.matchName)
    await deliverToUser(
      u,
      {
        type: 'match',
        title: m.matchName,
        body: stripHtml(body),
        ...safeLinkFields(m.matchId ? { screen: 'matches', chat: m.matchId } : { screen: 'matches' }),
      },
      () => notifyMatch([{
        telegramId: u.telegram_id as number,
        matchName: m.matchName,
        matchPhoto: m.matchPhoto,
        locale: localeOf(u),
        question: m.question,
        matchId: m.matchId,
      }]),
    )
  } catch (err) {
    console.error(`[notify] match notify to ${u.id} failed:`, (err as Error)?.message ?? err)
  }
}

/** "Someone liked you" (or a woman's daily reveal). Rethrows bot errors. */
export async function notifyUserLike(
  u: NotifyUser,
  likerName: string,
  type: 'like' | 'like_reveal',
): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    { type, title: likerName, body: stripHtml(t.notify.newLike(likerName)), ...safeLinkFields({ screen: 'likes' }) },
    () => notifyNewLike(u.telegram_id as number, likerName, localeOf(u)),
  )
}
