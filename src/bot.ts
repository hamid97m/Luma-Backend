import { Bot, Context, InlineKeyboard, webhookCallback } from 'grammy'
import { createHash } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { db } from './db.js'
import { WEBHOOK_ROUTE_PREFIX } from './webhookRoute.js'
import { createTicket, shouldCaptureSupport } from './support/service.js'
import { validatePreCheckout, handleGiftPaid } from './gifts/service.js'
import {
  PREMIUM_PAYLOAD_PREFIX, validatePremiumPreCheckout, handlePremiumPaid,
} from './premium/service.js'
import { t } from './i18n/index.js'
import type { MessageButton } from './messaging/messageButton.js'

let _bot: Bot | null = null

function getBot(): Bot {
  if (!_bot) _bot = new Bot(process.env.BOT_TOKEN!)
  return _bot
}

// Learned from Telegram at startup; API responses (e.g. the banned 401) use it
// so the frontend can deep-link into the bot chat without hardcoding the handle.
let botUsername: string | null = null

export function getBotUsername(): string | null {
  return botUsername
}

// The webhook lives under WEBHOOK_ROUTE_PREFIX (see webhookRoute.ts); the
// segment after it is an unguessable, BOT_TOKEN-derived token. server.ts exempts
// that prefix from the initData auth hook (Telegram sends no Authorization header).
//
// Two independent derivations from BOT_TOKEN so the value that appears in the
// URL (and thus in access logs) is never the same as the secret-token header
// that actually authenticates the request. No extra env var to configure.
function derive(salt: string): string {
  return createHash('sha256').update(`${process.env.BOT_TOKEN ?? ''}:${salt}`).digest('hex')
}

export function webhookPath(): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${derive('path').slice(0, 32)}`
}

function webhookSecretToken(): string {
  return derive('secret')
}

async function sendStart(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard().webApp(
    t.bot.openAppButton,
    process.env.WEB_URL!
  )
  await ctx.reply(t.bot.start, {
    reply_markup: keyboard,
  })
}

async function clearPending(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id
  if (tgId) await db.from('users').update({ awaiting_support_since: null }).eq('telegram_id', tgId)
}

async function promptSupport(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id
  if (tgId) {
    await db.from('users').update({ awaiting_support_since: new Date().toISOString() }).eq('telegram_id', tgId)
  }
  await ctx.reply(t.support.prompt)
}

let handlersRegistered = false

function registerHandlers(bot: Bot): void {
  if (handlersRegistered) return
  handlersRegistered = true

  // --- Telegram Stars payments (gifts + premium; must precede the message catch-alls) ---
  // The invoice payload routes: `premium:<txId>` -> premium, anything else -> gifts.
  bot.on('pre_checkout_query', async (ctx) => {
    const q = ctx.preCheckoutQuery
    const result = q.invoice_payload.startsWith(PREMIUM_PAYLOAD_PREFIX)
      ? await validatePremiumPreCheckout(q.invoice_payload.slice(PREMIUM_PAYLOAD_PREFIX.length), q.total_amount, q.currency)
      : await validatePreCheckout(q.invoice_payload, q.total_amount, q.currency)
    await ctx.answerPreCheckoutQuery(result.ok, result.ok ? undefined : { error_message: result.reason })
  })

  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment
    const run = sp.invoice_payload.startsWith(PREMIUM_PAYLOAD_PREFIX)
      ? handlePremiumPaid(sp.invoice_payload.slice(PREMIUM_PAYLOAD_PREFIX.length), sp.telegram_payment_charge_id, ctx.from.id, sp.total_amount)
      : handleGiftPaid(sp.invoice_payload, sp.telegram_payment_charge_id, ctx.from.id, sp.total_amount)
    await run.catch((err) => console.error('[bot] payment handler failed:', err?.message ?? err))
  })

  bot.command('start', async (ctx) => {
    // Deep link from the app's Blocked screen: t.me/<bot>?start=support
    if (ctx.match === 'support') return promptSupport(ctx)
    await clearPending(ctx)
    await sendStart(ctx)
  })

  bot.command('support', promptSupport)

  // Capture the next plain message as a ticket when a /support prompt is pending.
  bot.on('message', async (ctx, next) => {
    const tgId = ctx.from?.id
    const text = ctx.message?.text
    if (!tgId) return next()

    const { data: user } = await db
      .from('users')
      .select('id, awaiting_support_since')
      .eq('telegram_id', tgId)
      .maybeSingle()

    if (!user || !shouldCaptureSupport(text, user.awaiting_support_since ?? null, Date.now())) {
      return next()
    }

    await db.from('users').update({ awaiting_support_since: null }).eq('id', user.id)
    const result = await createTicket(user.id, text!)
    const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
    if (result.ok) {
      await ctx.reply(t.support.ticketSaved, { reply_markup: keyboard })
    } else if (result.error === 'too_many_open_tickets') {
      await ctx.reply(t.support.tooManyOpen)
    } else {
      await ctx.reply(t.support.saveFailed)
    }
  })

  // Any other command or message we don't explicitly support falls through
  // to here and is treated the same as /start.
  bot.on('message', sendStart)
}

/**
 * Register the Telegram webhook route on the Fastify app. Must run before
 * `app.listen()` (Fastify won't accept new routes afterwards). This only wires
 * up the in-process handler — no network calls; `initWebhook` tells Telegram
 * where to POST. The route is exempt from the global rate limit because bursts
 * of queued updates (e.g. after a restart) arrive from Telegram's IP range.
 */
export function mountWebhook(app: FastifyInstance): void {
  const bot = getBot()
  registerHandlers(bot)
  const handler = webhookCallback(bot, 'fastify', { secretToken: webhookSecretToken() })
  app.post(
    webhookPath(),
    { config: { rateLimit: false }, logLevel: 'silent' },
    handler as never,
  )
}

/**
 * Public-profile description shown on the bot's Telegram profile and in the
 * empty-chat screen ("What can this bot do?"). Set once at startup via
 * `setMyDescription`; max 512 chars per the Bot API.
 */
const BOT_DESCRIPTION = t.bot.description

/**
 * Initialise the bot and register the webhook with Telegram. Call AFTER
 * `app.listen()` so the endpoint is already accepting requests. `setWebhook`
 * also atomically disables any previous long-polling loop on Telegram's side,
 * so switching from polling to webhooks needs no manual `deleteWebhook`.
 */
export async function initWebhook(publicBaseUrl: string): Promise<void> {
  const bot = getBot()
  await bot.init()
  botUsername = bot.botInfo.username
  const url = `${publicBaseUrl.replace(/\/+$/, '')}${webhookPath()}`
  await bot.api.setWebhook(url, {
    secret_token: webhookSecretToken(),
    allowed_updates: ['message', 'pre_checkout_query'],
    drop_pending_updates: false,
  })
  await bot.api.setMyDescription(BOT_DESCRIPTION)
  console.log(`[bot] webhook set (@${botUsername})`)
}

export interface MatchNotifyRecipient {
  telegramId: number
  matchName: string
  matchPhoto: string | null
}

export async function notifyMatch(recipients: MatchNotifyRecipient[]): Promise<void> {
  const bot = getBot()

  const send = ({ telegramId, matchName, matchPhoto }: MatchNotifyRecipient) => {
    const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
    const caption = t.notify.match(matchName)

    return matchPhoto
      ? bot.api.sendPhoto(telegramId, matchPhoto, { caption, reply_markup: keyboard })
      : bot.api.sendMessage(telegramId, caption, { reply_markup: keyboard })
  }

  const results = await Promise.allSettled(recipients.map(send))
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      console.error(`[bot] match notify to ${recipients[i].telegramId} failed:`, r.reason?.message ?? r.reason)
    }
  }
}

/** DM a recipient that a new person liked them. Always names the liker (FOMO
 * teaser) even when they will be locked behind the paywall in-app. */
export async function notifyNewLike(
  toTelegramId: number,
  likerName: string,
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
  // Like DMs are text-only by design — no liker photo (the reveal happens in-app).
  await bot.api.sendMessage(toTelegramId, t.notify.newLike(likerName), { reply_markup: keyboard })
}

// Channel that receives an ops notification on every confirmed Stars purchase.
// Defaults to the internal payments channel; overridable via env so the target
// can be changed without a code edit. Set to an empty string to disable.
const DEFAULT_PAYMENT_NOTIFY_CHAT_ID = '-1004417654720'

function paymentNotifyChatId(): string | null {
  const id = process.env.PAYMENT_NOTIFY_CHAT_ID ?? DEFAULT_PAYMENT_NOTIFY_CHAT_ID
  const trimmed = id.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Post a payment-success notice to the ops channel. No-ops when the channel is
 * unconfigured (e.g. tests/local). Never throws — a notification failure must
 * not affect the payment flow; it only logs. */
export async function notifyPaymentChannel(text: string): Promise<void> {
  const chatId = paymentNotifyChatId()
  if (!chatId) return
  try {
    await getBot().api.sendMessage(chatId, text)
  } catch (err) {
    console.error('[bot] payment channel notify failed:', (err as Error)?.message ?? err)
  }
}

/** DM a user that their profile was paused for photo review and a new photo is
 * required to return to discovery. */
export async function notifyPaused(toTelegramId: number): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
  await bot.api.sendMessage(toTelegramId, t.notify.paused, { reply_markup: keyboard })
}

/** Build the optional inline keyboard for an admin message. Returns undefined
 * when no button is configured — the message then goes out with no keyboard.
 * Exported for unit testing of the url/screen/none branches. */
export function buildMessageKeyboard(button?: MessageButton): InlineKeyboard | undefined {
  if (!button) return undefined
  if (button.kind === 'url') return new InlineKeyboard().url(button.title, button.url)
  // screen → open the mini app at a specific tab via a query param.
  const url = `${process.env.WEB_URL!}?screen=${encodeURIComponent(button.screen)}`
  return new InlineKeyboard().webApp(button.title, url)
}

/** Raw admin DM (broadcast or single user). Optionally attaches one inline
 * button (url link or mini-app screen deep link); no button → no keyboard.
 * Throws on Telegram errors so the caller can react to 403/429. */
export async function sendBroadcastMessage(
  toTelegramId: number,
  text: string,
  button?: MessageButton,
): Promise<void> {
  const bot = getBot()
  const keyboard = buildMessageKeyboard(button)
  await bot.api.sendMessage(toTelegramId, text, keyboard ? { reply_markup: keyboard } : {})
}

export async function notifyNewMessage(
  toTelegramId: number,
  senderName: string,
  messageBody: string,
  senderPhoto: string | null = null
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
  const caption = t.notify.newMessage(senderName, messageBody)

  if (senderPhoto) {
    // Telegram caps photo captions at 1024 chars; a long message body would
    // otherwise make sendPhoto fail. Truncate — this is just a notification nudge.
    const photoCaption = caption.length > 1024 ? `${caption.slice(0, 1023)}…` : caption
    await bot.api.sendPhoto(toTelegramId, senderPhoto, { caption: photoCaption, reply_markup: keyboard })
  } else {
    await bot.api.sendMessage(toTelegramId, caption, { reply_markup: keyboard })
  }
}

/** DM a recipient that someone sent them a gift as an intro. */
export async function notifyGiftIntro(toTelegramId: number, senderName: string, emoji: string): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
  await bot.api.sendMessage(toTelegramId, t.notify.giftIntro(senderName, emoji), { reply_markup: keyboard })
}

export async function notifyTicketReply(
  toTelegramId: number,
  issuePreview: string,
  answer: string,
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp(t.bot.openAppButton, process.env.WEB_URL!)
  const preview = issuePreview.length > 200 ? `${issuePreview.slice(0, 199)}…` : issuePreview
  const text = t.support.ticketReply(preview, answer)
  const safe = text.length > 4000 ? `${text.slice(0, 3999)}…` : text
  await bot.api.sendMessage(toTelegramId, safe, { reply_markup: keyboard })
}

/** Telegram's catalog of gifts the bot can send. Return type is inferred from
 * grammy's own API types (Gift[]), avoiding a bare `@grammyjs/types` import that
 * isn't a declared backend dependency and fails to resolve in the deploy build. */
export async function getGiftCatalog() {
  const { gifts } = await getBot().api.getAvailableGifts()
  return gifts
}

/** Send a gift to a user, funded by the bot's Star float. `note` is clamped to 128 chars. */
export async function sendGiftToUser(telegramId: number, giftId: string, note?: string): Promise<void> {
  const text = note?.trim().slice(0, 128)
  await getBot().api.sendGift(telegramId, giftId, text ? { text } : undefined)
}

/** Create a Telegram Stars (XTR) invoice link. `payload` is the gift_transactions.id. */
export async function createGiftInvoiceLink(
  payload: string, title: string, description: string, stars: number,
): Promise<string> {
  return getBot().api.createInvoiceLink(
    title, description, payload, '', 'XTR', [{ label: title, amount: stars }],
  )
}

/** Refund a Stars payment (used when sendGift fails after the buyer paid). */
export async function refundGift(telegramId: number, chargeId: string): Promise<void> {
  await getBot().api.refundStarPayment(telegramId, chargeId)
}

/** Current bot Star balance (integer Stars). */
export async function getBotStarBalance(): Promise<number> {
  const { amount } = await getBot().api.getMyStarBalance()
  return amount
}

/** Stars invoice link for a premium purchase. Payload is `premium:<premium_transactions.id>`
 * so the shared bot payment handlers can dispatch between gifts and premium. */
export async function createPremiumInvoiceLink(
  transactionId: string, title: string, description: string, stars: number,
): Promise<string> {
  return getBot().api.createInvoiceLink(
    title, description, `premium:${transactionId}`, '', 'XTR', [{ label: title, amount: stars }],
  )
}

/** Refund a premium Stars payment (used when granting time fails after payment). */
export async function refundPremiumPayment(telegramId: number, chargeId: string): Promise<void> {
  await getBot().api.refundStarPayment(telegramId, chargeId)
}

/**
 * Fetch the user's current Telegram profile photo (server-side) as raw bytes.
 * Returns null when the user has no profile photo, or on any Telegram/network
 * failure — callers treat that as "no photo available" rather than an error.
 *
 * Telegram stores profile photos at ~640px max, so the largest available size
 * (the last / widest `PhotoSize` in the group) is the best resolution we can
 * get — there is no higher-res original to request.
 */
export async function fetchTelegramProfilePhoto(
  telegramId: number
): Promise<{ buffer: Buffer; mime: string } | null> {
  const bot = getBot()
  try {
    const photos = await bot.api.getUserProfilePhotos(telegramId, { limit: 1 })
    if (photos.total_count === 0 || photos.photos.length === 0) return null

    // photos.photos[0] is a PhotoSize[] sorted small→large; pick the largest.
    const group = photos.photos[0]
    const largest = group.reduce((a, b) => (b.width > a.width ? b : a))

    const file = await bot.api.getFile(largest.file_id)
    if (!file.file_path) return null

    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    // Derive the mime from the file extension, NOT the download response header:
    // Telegram's file server returns application/octet-stream for photo downloads,
    // which our storage bucket's allowed_mime_types (jpeg/png/webp/heic) rejects.
    // Profile photos are effectively always jpeg.
    const p = file.file_path.toLowerCase()
    const mime = p.endsWith('.png')
      ? 'image/png'
      : p.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg'
    return { buffer, mime }
  } catch (err) {
    console.error(`[bot] fetchTelegramProfilePhoto(${telegramId}) failed:`, (err as any)?.message ?? err)
    return null
  }
}
