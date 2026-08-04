import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from './db.js'
import { createTicket, shouldCaptureSupport } from './support/service.js'

let _bot: Bot | null = null

function getBot(): Bot {
  if (!_bot) _bot = new Bot(process.env.BOT_TOKEN!)
  return _bot
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

export function startBot(): void {
  const bot = getBot()

  bot.command('start', async (ctx) => {
    await clearPending(ctx)
    await sendStart(ctx)
  })

  bot.command('support', async (ctx) => {
    const tgId = ctx.from?.id
    if (tgId) {
      await db.from('users').update({ awaiting_support_since: new Date().toISOString() }).eq('telegram_id', tgId)
    }
    await ctx.reply("What's the issue? Send it to me in one message and I'll open a support ticket.")
  })

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
    onStart: () => console.log('[bot] polling started'),
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
