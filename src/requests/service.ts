import { sql, isUuid } from '../db.js'
import { ensureMatch, insertOpener } from '../matches/ensureMatch.js'
import { seedIcebreakers } from '../icebreakers/seed.js'
import { closeAsksOnDecision } from '../asks/service.js'
import { isPremiumActive } from '../premium/service.js'
import { notifyUserMessageRequest, notifyUserRequestAccepted, type NotifyUser } from '../notify/userNotify.js'
import { publishRequest } from '../realtime/requests.js'
import { trackMessageWork } from '../messaging/inflight.js'
import { tFor, type Locale } from '../i18n/index.js'

// Message requests: the opener of a direct chat to a woman waits in her
// Requests inbox until she accepts (→ match) or ignores it.
export const REQUEST_MESSAGE_MAX = 500
/** Waiting requests (as the sender sees them) at which sending stops. */
export const MAX_PENDING_REQUESTS = 10
export const REQUEST_TTL_DAYS = 7

/** Not older than the TTL. Expiry is lazy: nothing sweeps old pending rows. */
const alive = () => sql`mr.created_at > now() - make_interval(days => ${REQUEST_TTL_DAYS})`

/** The other person (`s`) can be shown to `me`: not deleted/banned/paused, no block either way. */
const visibleTo = (me: string) => sql`
  s.deleted_at is null and s.banned_at is null and s.paused_at is null
  and not exists (
    select 1 from blocks b
    where (b.blocker_id = ${me} and b.blocked_id = s.id) or (b.blocker_id = s.id and b.blocked_id = ${me}))`

/**
 * The requests a SENDER sees as waiting (`s` = the recipient). An ignored one
 * stays in this set until it would have expired, so ignoring is unobservable:
 * the sent list and the cap both use exactly this set.
 */
const waitingFrom = (senderId: string) => sql`
  from message_requests mr
  join users s on s.id = mr.recipient_id
  where mr.sender_id = ${senderId} and mr.status in ('pending', 'ignored')
    and ${alive()} and ${visibleTo(senderId)}`

/** The one request this sender ever made to this person, whatever became of it. */
export async function findRequest(senderId: string, recipientId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from message_requests where sender_id = ${senderId} and recipient_id = ${recipientId}`
  return row?.id ?? null
}

export async function waitingCount(senderId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n ${waitingFrom(senderId)}`
  return n
}

/** Insert a pending request; `created: false` when a concurrent one won. */
export async function createRequest(
  senderId: string, recipientId: string, body: string,
): Promise<{ id: string; created: boolean }> {
  const [created] = await sql<{ id: string }[]>`
    insert into message_requests (sender_id, recipient_id, body)
    values (${senderId}, ${recipientId}, ${body})
    on conflict (sender_id, recipient_id) do nothing
    returning id`
  if (created) return { id: created.id, created: true }
  const existing = await findRequest(senderId, recipientId)
  if (!existing) throw new Error('request vanished during a concurrent insert')
  return { id: existing, created: false }
}

/** Fire-and-forget: live event for an open app + push / bot DM. Never throws. */
export function announceRequest(requestId: string, senderId: string, recipient: NotifyUser): void {
  void trackMessageWork((async () => {
    try {
      await publishRequest({ requestId, to: recipient.id })
    } catch (err) {
      console.error('[requests] publish failed:', (err as Error)?.message ?? err)
    }
    try {
      const [sender] = await sql<{ name: string | null }[]>`select name from users where id = ${senderId}`
      const name = sender?.name || tFor(recipient.locale as Locale | null).notify.fallbackName
      await notifyUserMessageRequest(recipient, name)
    } catch (err) {
      console.error(`[requests] notify ${recipient.id} failed:`, (err as Error)?.message ?? err)
    }
  })())
}

export async function listReceived(userId: string) {
  const rows = await sql`
    select mr.id, mr.body, mr.created_at,
      s.id as user_id, s.name, s.age, s.bio, s.location, s.interests, s.premium_until,
      coalesce((select array_agg(p.url order by p.position) from user_photos p where p.user_id = s.id), '{}') as photos
    from message_requests mr
    join users s on s.id = mr.sender_id
    where mr.recipient_id = ${userId} and mr.status = 'pending' and ${alive()} and ${visibleTo(userId)}
    order by mr.created_at desc, mr.id`
  return rows.map((r) => ({
    id: r.id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
    // Same card as GET /likes `visible`, minus likedAt.
    user: {
      id: r.user_id, name: r.name, age: r.age, bio: r.bio, location: r.location,
      interests: r.interests ?? [], photos: r.photos ?? [], premium: isPremiumActive(r.premium_until ?? null),
    },
  }))
}

export async function listSent(userId: string) {
  const rows = await sql`
    select mr.id, mr.body, mr.created_at, s.id as user_id, s.name,
      (select p.url from user_photos p where p.user_id = s.id order by p.position asc limit 1) as photo
    ${waitingFrom(userId)}
    order by mr.created_at desc, mr.id`
  return rows.map((r) => ({
    id: r.id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
    user: { id: r.user_id, name: r.name, photo: r.photo ?? null },
  }))
}

export type RequestError = 'request_not_found' | 'already_handled' | 'not_available' | 'match_failed'

/** Why a claim matched nothing. A request that can no longer be accepted is
 *  retired: 'expired' when too old, otherwise 'ignored' (so the sender can't
 *  tell either way). */
async function claimMiss(id: string, userId: string): Promise<{ error: RequestError }> {
  const [row] = await sql<{ status: string }[]>`
    select status from message_requests where id = ${id} and recipient_id = ${userId}`
  if (!row) return { error: 'request_not_found' }
  if (row.status === 'accepted' || row.status === 'ignored') return { error: 'already_handled' }
  await sql`
    update message_requests mr set decided_at = now(),
      status = case when ${alive()} then 'ignored' else 'expired' end
    where mr.id = ${id} and mr.status = 'pending'`
  return { error: 'not_available' }
}

export async function acceptRequest(id: string, userId: string) {
  if (!isUuid(id)) return { error: 'request_not_found' as RequestError }
  // Atomic claim, sender checks included: a double tap can't accept (and deliver
  // the opener) twice, and no match is made with an unavailable sender.
  const [claimed] = await sql<{
    sender_id: string; body: string; name: string
    telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null
  }[]>`
    update message_requests mr set status = 'accepted', decided_at = now()
    from users s
    where mr.id = ${id} and mr.recipient_id = ${userId} and mr.status = 'pending' and ${alive()}
      and s.id = mr.sender_id and ${visibleTo(userId)}
    returning mr.sender_id, mr.body, s.name, s.telegram_id, s.allows_write_to_pm, s.locale`
  if (!claimed) return claimMiss(id, userId)

  const match = await ensureMatch(claimed.sender_id, userId)
  let delivered = false
  if (match) {
    if (match.created) await seedIcebreakers(match.matchId, [claimed.sender_id, userId])
    try {
      await insertOpener(match.matchId, claimed.sender_id, claimed.body)
      delivered = true
    } catch (err) {
      console.error(`[requests] opener insert failed for ${id}:`, (err as Error)?.message ?? err)
    }
  }
  if (!match || !delivered) {
    // Back to pending so she can retry; a match created above is simply reused.
    await sql`
      update message_requests set status = 'pending', decided_at = null where id = ${id} and status = 'accepted'`
      .catch((err) => console.error(`[requests] failed to revert claim ${id}:`, (err as Error)?.message ?? err))
    return { error: 'match_failed' as RequestError }
  }

  // Bookkeeping: the chat is already open, so a failed link never fails the accept.
  await sql`update message_requests set match_id = ${match.matchId} where id = ${id}`
    .catch((err) => console.error(`[requests] failed to link ${id} to match:`, (err as Error)?.message ?? err))
  await closeAsksOnDecision(userId, claimed.sender_id, 'messaged')

  const sender: NotifyUser = {
    id: claimed.sender_id, telegram_id: claimed.telegram_id,
    allows_write_to_pm: claimed.allows_write_to_pm, locale: claimed.locale,
  }
  void trackMessageWork((async () => {
    try {
      const [me] = await sql<{ name: string | null }[]>`select name from users where id = ${userId}`
      await notifyUserRequestAccepted(
        sender, me?.name || tFor(sender.locale as Locale | null).notify.fallbackName, match.matchId,
      )
    } catch (err) {
      console.error(`[requests] accept notify ${sender.id} failed:`, (err as Error)?.message ?? err)
    }
  })())

  return { match: { id: match.matchId, matchedAt: match.matchedAt, user: { id: claimed.sender_id, name: claimed.name } } }
}

/** Silent: nothing is sent to the sender, and he keeps seeing it as waiting. */
export async function ignoreRequest(id: string, userId: string) {
  if (!isUuid(id)) return { error: 'request_not_found' as RequestError }
  const [claimed] = await sql`
    update message_requests mr set status = 'ignored', decided_at = now()
    where mr.id = ${id} and mr.recipient_id = ${userId} and mr.status = 'pending' and ${alive()}
    returning mr.id`
  if (!claimed) return claimMiss(id, userId)
  return { ok: true as const }
}
