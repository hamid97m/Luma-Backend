import { Bot, Context, InlineKeyboard } from 'grammy'

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

export function startBot(): void {
  const bot = getBot()

  bot.command('start', sendStart)

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
