import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from './db.js'
import { createTicket, shouldCaptureSupport } from './support/service.js'
import { validatePreCheckout, handleGiftPaid } from './gifts/service.js'
import {
  PREMIUM_PAYLOAD_PREFIX, validatePremiumPreCheckout, handlePremiumPaid,
} from './premium/service.js'

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

async function sendStart(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard().webApp(
    'Open Luma ❤️',
    process.env.WEB_URL!
  )
  await ctx.reply('Come to the app → catch matches 💫 You can pause or delete your account anytime.', {
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
  await ctx.reply("What's the issue? Send it to me in one message and I'll open a support ticket.")
}

export function startBot(): void {
  const bot = getBot()

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
      ? handlePremiumPaid(sp.invoice_payload.slice(PREMIUM_PAYLOAD_PREFIX.length), sp.telegram_payment_charge_id, ctx.from.id)
      : handleGiftPaid(sp.invoice_payload, sp.telegram_payment_charge_id, ctx.from.id)
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
    const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
    if (result.ok) {
      await ctx.reply("Thanks — your ticket is in. We'll reply here and in the app.", { reply_markup: keyboard })
    } else if (result.error === 'too_many_open_tickets') {
      await ctx.reply("You already have several open tickets — please wait for a reply before opening another.")
    } else {
      await ctx.reply("Sorry, I couldn't save that. Please try /support again.")
    }
  })

  // Any other command or message we don't explicitly support falls through
  // to here and is treated the same as /start.
  bot.on('message', sendStart)

  bot.start({
    onStart: (me) => {
      botUsername = me.username
      console.log('[bot] polling started')
    },
  }).catch((err) => {
    // 409 happens during rolling restarts — log and exit so Render restarts cleanly
    console.error('[bot] fatal:', err.message)
    process.exit(1)
  })
}

export interface MatchNotifyRecipient {
  telegramId: number
  matchName: string
  matchPhoto: string | null
}

export async function notifyMatch(recipients: MatchNotifyRecipient[]): Promise<void> {
  const bot = getBot()

  const send = ({ telegramId, matchName, matchPhoto }: MatchNotifyRecipient) => {
    const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
    const caption = `${matchName} just liked you! Open Luma ❤️`

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
  likerPhoto: string | null = null,
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
  const caption = `${likerName} liked you 💛 — open Luma to see`
  if (likerPhoto) {
    await bot.api.sendPhoto(toTelegramId, likerPhoto, { caption, reply_markup: keyboard })
  } else {
    await bot.api.sendMessage(toTelegramId, caption, { reply_markup: keyboard })
  }
}

export async function notifyNewMessage(
  toTelegramId: number,
  senderName: string,
  messageBody: string,
  senderPhoto: string | null = null
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
  const caption = `New message from ${senderName}\n${messageBody}`

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
  const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
  await bot.api.sendMessage(toTelegramId, `${senderName} sent you a gift ${emoji} — open Luma to see who!`, { reply_markup: keyboard })
}

export async function notifyTicketReply(
  toTelegramId: number,
  issuePreview: string,
  answer: string,
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
  const preview = issuePreview.length > 200 ? `${issuePreview.slice(0, 199)}…` : issuePreview
  const text = `📮 Support reply\n\nYour issue:\n"${preview}"\n\nOur answer:\n${answer}`
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
