import { sql } from '../db.js'
import { chatHub, type ChatHub } from './hub.js'
import { TYPING_CHANNEL } from './typing.js'

export const CHAT_CHANNEL = 'luma_chat'
export { TYPING_CHANNEL }
const RETRY_MS = 5_000

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void }

/** LISTEN on one channel; if the very first LISTEN fails (DB down at boot) retry until it succeeds. */
function listenWithRetry(log: Log, channel: string, onNotify: (payload: string) => void, onListen?: () => void): void {
  const attempt = () => {
    sql
      .listen(channel, onNotify, () => {
        log.info('realtime: listening on %s', channel)
        onListen?.()
      })
      .catch((err) => {
        log.warn({ err }, 'realtime: LISTEN %s failed, retrying', channel)
        setTimeout(attempt, RETRY_MS)
      })
  }
  attempt()
}

/**
 * LISTEN on `luma_chat` and `luma_typing` (one dedicated connection, managed by
 * postgres.js) and feed the hub. postgres.js reconnects and re-LISTENs on its
 * own, calling `onlisten` each time; every (re)listen of `luma_chat` sends
 * `resync` to open streams, since notifies during the gap are gone (on the first
 * listen there are no streams yet, or they opened before we were listening —
 * either way a refetch is right). Missed typing pings need no recovery.
 *
 * Started explicitly from index.ts — never on import, so tests don't LISTEN.
 */
export function startChatListener(log: Log, hub: ChatHub = chatHub): void {
  listenWithRetry(log, CHAT_CHANNEL, (payload) => hub.handleNotify(payload), () => hub.resyncAll())
  listenWithRetry(log, TYPING_CHANNEL, (payload) => hub.handleTyping(payload))
}
