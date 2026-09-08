export interface ParsedChannelMessage {
  /** Telegram from_chat_id: '@username' for public channels or '-100…' for private. */
  chatId: string
  messageId: number
}

// Public channel usernames: 5–32 chars, must start with a letter, then letters/digits/_.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/

/**
 * Parse a t.me message link into a forwardable (chatId, messageId) pair.
 * Handles public links (`t.me/<username>/<id>`) and private links
 * (`t.me/c/<internal>/<id>`, mapped to `-100<internal>`), including threaded
 * variants where a topic id precedes the message id. Returns null for anything
 * that isn't a channel message link (invite links, junk, missing id, …).
 */
export function parseChannelMessageLink(input: string): ParsedChannelMessage | null {
  const raw = (input ?? '').trim()
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  if (host !== 't.me' && host !== 'www.t.me' && host !== 'telegram.me') return null

  const parts = url.pathname.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  const messageId = Number(last)
  const validMessageId = /^\d+$/.test(last ?? '') && Number.isInteger(messageId) && messageId > 0

  // Private channel: /c/<internalId>/<messageId>  (optionally /c/<id>/<thread>/<messageId>)
  if (parts[0] === 'c') {
    const internal = parts[1]
    if (parts.length < 3 || !/^\d+$/.test(internal ?? '') || !validMessageId) return null
    return { chatId: `-100${internal}`, messageId }
  }

  // Public channel: /<username>/<messageId>  (optionally /<username>/<thread>/<messageId>)
  const username = parts[0]
  if (parts.length < 2 || !USERNAME_RE.test(username ?? '') || !validMessageId) return null
  return { chatId: `@${username}`, messageId }
}
