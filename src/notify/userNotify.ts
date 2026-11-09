import {
  notifyMatch, notifyNewLike, notifyNewMessage, notifyGiftIntro, notifyReferralQualified, notifyReferralReward,
  notifyPremiumPurchased, notifyPaused, notifyFakePhotoWarning, notifyTicketReply, sendBroadcastMessage,
  referralRewardText, fakePhotoWarningText, ticketReplyText,
} from '../bot.js'
import { sendPushToUser, isPushConfigured, type PushPayload } from '../push/fcm.js'
import { isStandby } from '../appMode.js'
import { sql } from '../db.js'
import { linkFields, linkFromButton } from '../push/links.js'
import type { MessageButton } from '../messaging/messageButton.js'
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

// FCM caps a whole message at 4 KB; bodies are a nudge, the app has the rest.
const MAX_PUSH_BODY = 1000
const clipBody = (s: string) => (s.length > MAX_PUSH_BODY ? `${s.slice(0, MAX_PUSH_BODY - 1)}…` : s)

/**
 * Channel choice for one notification. Push first; the bot DM goes out only
 * when no push was delivered (no tokens, all dead/failed, push disabled) and
 * the user can receive bot DMs. A failing push (e.g. DB error pruning dead
 * tokens) is logged and counts as zero sent. Bot errors are rethrown so
 * callers keep their own 403 handling.
 *
 * `push` may be a thunk so the payload (and any bot.ts text helper it calls)
 * is only built when push is actually attempted.
 *
 * `ignoreBotOptOut`: the bot fallback only needs telegram_id > 0, ignoring
 * allows_write_to_pm — for DMs that never checked the flag (gifts, premium
 * purchase), so Telegram users without a token keep today's exact DM.
 *
 * `allowBot: false`: push only — no bot fallback this time (new-message
 * pushes go out before the bot DM's 10-minute offline wait is over).
 */
export interface DeliverOptions { ignoreBotOptOut?: boolean; allowBot?: boolean }

export async function deliverToUser(
  u: NotifyUser,
  push: PushPayload | (() => PushPayload),
  botSend: () => Promise<void>,
  opts: DeliverOptions = {},
): Promise<'push' | 'bot' | 'none'> {
  let sent = 0
  // Checked here too (sendPushToUser also does) so that with push off the bot
  // DM starts in the same tick as before push existed — no extra awaits.
  if (isPushConfigured() && !isStandby()) {
    try {
      const p = typeof push === 'function' ? push() : push
      sent = (await sendPushToUser(u.id, { ...p, body: clipBody(p.body) })).sent
    } catch (err) {
      console.error(`[notify] push to ${u.id} failed:`, (err as Error)?.message ?? err)
    }
  }
  if (sent > 0) return 'push'
  if (opts.allowBot === false) return 'none'
  const botOk = opts.ignoreBotOptOut ? (u.telegram_id ?? 0) > 0 : canBotDm(u)
  if (!botOk) return 'none'
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

/**
 * The user read a chat: a data-only 'message_read' push to their own devices
 * so the app cancels the notification tagged with this chatId — but only when
 * a message push for this chat was actually delivered since the last clear
 * (its 'push' rows in message_notifications are consumed atomically here).
 * An open chat reads every live message, and those never showed anything.
 * Push only (no bot fallback); users without tokens get nothing. Never throws (logs).
 */
export async function notifyUserMessageRead(userId: string, matchId: string): Promise<void> {
  if (!isPushConfigured() || isStandby()) return
  try {
    const consumed = await sql`
      delete from message_notifications
      where user_id = ${userId} and match_id = ${matchId} and channel = 'push'
      returning 1`
    if (consumed.length === 0) return
    const { link } = safeLinkFields({ screen: 'matches', chat: matchId })
    await sendPushToUser(userId, { type: 'message_read', title: '', body: '', link, chatId: matchId, dataOnly: true })
  } catch (err) {
    console.error(`[notify] message_read push to ${userId} failed:`, (err as Error)?.message ?? err)
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

/** True when a notification can reach the user on some channel: a bot DM, or
 * (with push on) a stored push token. For callers that report "handed off". */
export async function canReachUser(u: NotifyUser): Promise<boolean> {
  if (canBotDm(u)) return true
  if (!isPushConfigured() || isStandby()) return false
  const rows = await sql`
    select 1 from user_devices where user_id = ${u.id} and push_token is not null limit 1`
  return rows.length > 0
}

const tg = (u: NotifyUser) => u.telegram_id as number
const homeLink = () => safeLinkFields()

/** Gift sent inside a chat (shown like a new message, no chat deep link).
 * Bot fallback ignores allows_write_to_pm, as before. Rethrows bot errors. */
export async function notifyUserGiftMessage(
  u: NotifyUser,
  senderName: string,
  emoji: string,
): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  const body = t.gifts.sentYouGift(emoji)
  return deliverToUser(
    u,
    () => ({
      type: 'gift_message',
      title: t.push.title.gift,
      body: stripHtml(t.notify.newMessage(senderName, body)),
      ...safeLinkFields({ screen: 'matches' }),
    }),
    () => notifyNewMessage(tg(u), senderName, body, null, undefined, localeOf(u)),
    { ignoreBotOptOut: true },
  )
}

/** Discovery gift waiting in the intros inbox. Bot fallback ignores
 * allows_write_to_pm, as before. Rethrows bot errors. */
export async function notifyUserGiftIntro(
  u: NotifyUser,
  senderName: string,
  emoji: string,
): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({ type: 'gift_intro', title: t.push.title.gift, body: stripHtml(t.notify.giftIntro(senderName, emoji)), ...homeLink() }),
    () => notifyGiftIntro(tg(u), senderName, emoji, localeOf(u)),
    { ignoreBotOptOut: true },
  )
}

/** Someone the user invited completed a profile. (The bot half logs and never throws.) */
export async function notifyUserReferralQualified(u: NotifyUser, referredName: string): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({
      type: 'referral_qualified', title: t.push.title.referralQualified,
      body: stripHtml(t.referral.qualified(referredName)), ...homeLink(),
    }),
    () => notifyReferralQualified(tg(u), referredName, localeOf(u)),
  )
}

/** Referral milestone reward granted. (The bot half logs and never throws.) */
export async function notifyUserReferralReward(
  u: NotifyUser,
  milestone: { rewardType: string; rewardAmount: number },
): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({
      type: 'referral_reward', title: t.push.title.referralReward,
      body: stripHtml(referralRewardText(milestone, localeOf(u))), ...homeLink(),
    }),
    () => notifyReferralReward(tg(u), milestone, localeOf(u)),
  )
}

/** Premium purchase is active. Bot fallback ignores allows_write_to_pm, as
 * before (Stars + TonPays). Rethrows bot errors. */
export async function notifyUserPremiumPurchased(u: NotifyUser, durationDays: number): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({
      type: 'premium_purchased', title: t.push.title.premiumPurchased,
      body: stripHtml(t.premium.purchased(durationDays)), ...homeLink(),
    }),
    () => notifyPremiumPurchased(tg(u), durationDays, localeOf(u)),
    { ignoreBotOptOut: true },
  )
}

/** Profile paused for photo review (the app shows its paused screen). Rethrows bot errors. */
export async function notifyUserPaused(u: NotifyUser): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({ type: 'account_paused', title: t.push.title.accountPaused, body: stripHtml(t.notify.paused), ...homeLink() }),
    () => notifyPaused(tg(u), localeOf(u)),
  )
}

/** Halfway fake-photo warning; opens the profile to change the photo. Rethrows bot errors. */
export async function notifyUserPhotoWarning(u: NotifyUser, gender: string | null): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({
      type: 'photo_warning', title: t.push.title.photoWarning,
      body: stripHtml(fakePhotoWarningText(localeOf(u), gender)), ...safeLinkFields({ screen: 'profile' }),
    }),
    () => notifyFakePhotoWarning(tg(u), localeOf(u), gender),
  )
}

/** Admin answered a support ticket. Rethrows bot errors. */
export async function notifyUserSupportReply(
  u: NotifyUser,
  question: string,
  answer: string,
): Promise<'push' | 'bot' | 'none'> {
  const t = tFor(localeOf(u))
  return deliverToUser(
    u,
    () => ({
      type: 'support_reply', title: t.push.title.supportReply,
      body: stripHtml(ticketReplyText(question, answer, localeOf(u))), ...homeLink(),
    }),
    () => notifyTicketReply(tg(u), question, answer, localeOf(u)),
  )
}

/** linkFromButton that never throws (WEB_URL unset → empty link). */
function safeLinkFromButton(button?: MessageButton): ReturnType<typeof linkFromButton> {
  try {
    return linkFromButton(button)
  } catch {
    if (button?.kind === 'url') return { link: '', url: button.url }
    if (button?.kind === 'screen') return { link: '', screen: button.screen }
    return { link: '' }
  }
}

/**
 * Admin-written text (one-off admin message, abandoned-checkout reminder).
 * Title falls back to the app name; the button becomes the push link. The bot
 * half is `sendBroadcastMessage` (or `sendText`, for injected test senders).
 * Rethrows bot errors so callers keep their 403/429 handling.
 */
export async function notifyUserText(
  u: NotifyUser,
  m: { type: 'admin_message' | 'purchase_reminder'; title?: string | null; text: string; button?: MessageButton },
  sendText: (telegramId: number, text: string, button?: MessageButton) => Promise<void> = sendBroadcastMessage,
): Promise<'push' | 'bot' | 'none'> {
  return deliverToUser(
    u,
    () => ({
      type: m.type,
      title: m.title?.trim() || tFor(localeOf(u)).push.title.app,
      body: m.text,
      ...safeLinkFromButton(m.button),
    }),
    () => sendText(tg(u), m.text, m.button),
  )
}
