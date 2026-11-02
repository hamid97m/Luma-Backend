import { sql } from '../db.js'
import { chatHub, type ChatHub } from './hub.js'

export const CHAT_CHANNEL = 'luma_chat'
const RETRY_MS = 5_000

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void }

/**
 * LISTEN on `luma_chat` (one dedicated connection, managed by postgres.js) and
 * feed the hub. postgres.js reconnects and re-LISTENs on its own, calling
 * `onlisten` each time; every (re)listen sends `resync` to open streams, since
 * notifies during the gap are gone (on the first listen there are no streams yet,
 * or they opened before we were listening — either way a refetch is right).
 *
 * Started explicitly from index.ts — never on import, so tests don't LISTEN.
 * If the very first LISTEN fails (DB down at boot) it retries until it succeeds.
 */
export function startChatListener(log: Log, hub: ChatHub = chatHub): void {
  const attempt = () => {
    sql
      .listen(CHAT_CHANNEL, (payload) => hub.handleNotify(payload), () => {
        log.info('realtime: listening on %s', CHAT_CHANNEL)
        hub.resyncAll()
      })
      .catch((err) => {
        log.warn({ err }, 'realtime: LISTEN failed, retrying')
        setTimeout(attempt, RETRY_MS)
      })
  }
  attempt()
}
