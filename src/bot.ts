import { Bot, InlineKeyboard } from 'grammy'

let _bot: Bot | null = null

function getBot(): Bot {
  if (!_bot) _bot = new Bot(process.env.BOT_TOKEN!)
  return _bot
}

export function startBot(): void {
  const bot = getBot()

  bot.command('start', async (ctx) => {
    const keyboard = new InlineKeyboard().webApp(
      '💘 باز کن',
      process.env.WEB_URL!
    )
    await ctx.reply('به دیتگرام خوش آمدید! 💝\nهمین الان شروع کن:', {
      reply_markup: keyboard,
    })
  })

  bot.start()
}

export async function notifyMatch(
  tgId1: number,
  name1: string,
  tgId2: number,
  name2: string
): Promise<void> {
  const bot = getBot()

  const send = (toId: number, matchName: string, matchTgId: number) =>
    bot.api.sendMessage(
      toId,
      `💘 شما با ${matchName} match شدید!`,
      {
        reply_markup: new InlineKeyboard().url(
          `💬 پیام بده به ${matchName}`,
          `tg://user?id=${matchTgId}`
        ),
      }
    )

  await Promise.all([send(tgId1, name2, tgId2), send(tgId2, name1, tgId1)])
}
