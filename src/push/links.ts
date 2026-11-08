import type { MessageButton } from '../messaging/messageButton.js'

/** Deep link into the app, same URLs the bot's web_app buttons open
 *  (WEB_URL?screen=…&chat=…). No opts → WEB_URL unchanged. */
export function appLink(opts: { screen?: string; chat?: string } = {}): string {
  const base = process.env.WEB_URL!
  if (!opts.screen && !opts.chat) return base
  const u = new URL(base)
  if (opts.screen) u.searchParams.set('screen', opts.screen)
  if (opts.chat) u.searchParams.set('chat', opts.chat)
  return u.toString()
}

export function linkFields(opts: { screen?: string; chat?: string } = {}): {
  link: string
  screen?: string
  chatId?: string
} {
  const out: { link: string; screen?: string; chatId?: string } = { link: appLink(opts) }
  if (opts.screen) out.screen = opts.screen
  if (opts.chat) out.chatId = opts.chat
  return out
}

export function linkFromButton(button?: MessageButton): { link: string; screen?: string; url?: string } {
  if (!button) return { link: appLink() }
  if (button.kind === 'url') return { link: appLink(), url: button.url }
  return { link: appLink({ screen: button.screen }), screen: button.screen }
}
