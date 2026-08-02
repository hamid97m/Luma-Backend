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

export async function notifyMatch(
  tgId1: number,
  name1: string,
  photo1: string | null,
  tgId2: number,
  name2: string,
  photo2: string | null
): Promise<void> {
  const bot = getBot()

  const send = (toId: number, matchName: string, matchPhoto: string | null) => {
    const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
    const caption = `${matchName} just liked you! Open Luma ❤️`

    return matchPhoto
      ? bot.api.sendPhoto(toId, matchPhoto, { caption, reply_markup: keyboard })
      : bot.api.sendMessage(toId, caption, { reply_markup: keyboard })
  }

  await Promise.all([send(tgId1, name2, photo2), send(tgId2, name1, photo1)])
}

export async function notifyNewMessage(
  toTelegramId: number,
  senderName: string,
  messageBody: string
): Promise<void> {
  const bot = getBot()
  const keyboard = new InlineKeyboard().webApp('Open Luma ❤️', process.env.WEB_URL!)
  await bot.api.sendMessage(toTelegramId, `New message from ${senderName}\n${messageBody}`, {
    reply_markup: keyboard,
  })
}
