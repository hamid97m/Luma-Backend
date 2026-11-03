import { sql } from '../db.js'

/** The tag in a `?start=` payload, or null when the payload isn't one. Tags are
 *  free-form and lowercased so Insta and insta group together. `support` and
 *  `ref_` have their own meaning in /start, and `none` is the admin Users filter
 *  for "no tag"; they're compared after lowercasing so that no casing of them
 *  can create a tag of the same name. */
export function parseJoinTag(payload: string | null | undefined): string | null {
  if (!payload || !/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null
  const tag = payload.toLowerCase()
  if (tag === 'support' || tag === 'none' || tag.startsWith('ref_')) return null
  return tag
}

/** A person opened a tagged link in the bot. */
export async function recordJoinTagStart(telegramId: number, tag: string): Promise<void> {
  try {
    await sql`
      insert into join_tag_starts (tag, telegram_id, existing_user)
      values (${tag}, ${telegramId}, exists (select 1 from users where telegram_id = ${telegramId}))
      on conflict do nothing`
  } catch (err) {
    // best-effort; a lost start only loses attribution, never breaks /start
    console.error('[join-tags] recording start failed:', (err as Error)?.message ?? err)
  }
}

/** Ties a new account to the first tag its Telegram user opened. Starts made
 *  while they already had an account don't count. */
export async function captureJoinTag(newUserId: string, telegramId: number): Promise<void> {
  try {
    await sql`
      update users u set join_tag = s.tag
      from (
        select tag from join_tag_starts
        where telegram_id = ${telegramId} and not existing_user
        order by first_at asc, tag asc
        limit 1
      ) s
      where u.id = ${newUserId} and u.join_tag is null`
  } catch (err) {
    // attribution must never break signup
    console.error('[join-tags] attribution failed:', (err as Error)?.message ?? err)
  }
}
