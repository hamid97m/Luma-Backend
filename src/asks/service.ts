import { sql, isUuid } from '../db.js'
import type { TelegramUser } from '../types.js'
import {
  ASK_TTL_MS, ASK_MAX_RECIPIENTS, ASK_MAX_OPEN, ASK_MAX_PER_DAY, ASK_EDIT_WINDOW_MS,
  ASK_REMIND_AFTER_MS, ASK_ANSWER_NOTIFY_GAP_MS, ASK_NOTE_MAX, canUseAskFriend,
} from './config.js'
import { newAskToken, hashAskToken, isAskTokenShape, askLink } from './tokens.js'
import { notifyAskMember, notifyAskAnswered, notifyAskRemind } from './notify.js'
import { askPhotoUrl } from './photoUrl.js'
import { isPremiumActive } from '../premium/service.js'

/**
 * "Ask a friend": a woman shows one profile (the target) to 1-3 friends and
 * collects a verdict. Privacy rules enforced here:
 *  - the target is never notified and no target-facing response mentions asks;
 *  - a recipient who is not a woman learns nothing about the profile or requester;
 *  - a recipient blocked with the target (either way) only sees "closed";
 *  - a link is locked to the first Telegram account that opens it with initData.
 * Non-member advisors have no users row: they're the Telegram id on ask_recipients.
 */

export type AskQuestion = 'reply' | 'date' | 'red_flag'
export type AskVerdict = 'yes' | 'unsure' | 'no'
export const ASK_QUESTIONS: readonly AskQuestion[] = ['reply', 'date', 'red_flag']
export const ASK_VERDICTS: readonly AskVerdict[] = ['yes', 'unsure', 'no']
type AskStatus = 'open' | 'closed' | 'expired'

export type AskSummary = {
  id: string; targetId: string; targetName: string; targetPhotoUrl: string | null
  question: AskQuestion; status: AskStatus; createdAt: string; expiresAt: string
  total: number; answered: number; yes: number; unsure: number; no: number
}

export type AskDetail = AskSummary & {
  target: { id: string; name: string; age: number; photoUrl: string | null }
  recipients: Array<{
    id: string; kind: 'member' | 'link'; displayName: string | null
    status: 'unseen' | 'seen' | 'answered'; verdict: AskVerdict | null; note: string | null
    answeredAt: string | null; canRemind: boolean; foreignOpen: boolean
  }>
}

export type RecipientView = {
  recipientId: string; requesterName: string; requesterPhotoUrl: string | null
  question: AskQuestion; status: AskStatus; watermark: string
  /** The viewer has a finished Luma profile (users row with age > 0). */
  isMember: boolean
  profile: {
    name: string; age: number; location: string | null; bio: string | null
    interests: string[]; photos: string[]
  }
  myAnswer: { verdict: AskVerdict; note: string | null; answeredAt: string; editableUntil: string } | null
}

export type LinkState =
  | { state: 'landing'; requesterName: string; question: AskQuestion }
  | { state: 'need_gender'; requesterName: string; question: AskQuestion }
  | { state: 'not_for_you' } | { state: 'taken' } | { state: 'closed' } | { state: 'invalid' }
  | { state: 'ready'; view: RecipientView }

type Fail = { ok: false; status: number; body: Record<string, unknown> }
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Fail =>
  ({ ok: false, status, body: { error, ...extra } })

/** An open row past its expiry reads as expired even before the job runs. */
const effStatus = () => sql`(case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end)`
const primaryPhoto = (userIdCol: ReturnType<typeof sql>) =>
  sql`(select p.url from user_photos p where p.user_id = ${userIdCol} order by p.position asc limit 1)`

// ── Events ──────────────────────────────────────────────────────────────────

/** Client events (PRD analytics table) plus the server-side ones. */
export const CLIENT_ASK_EVENTS = new Set([
  'ask_tooltip_shown', 'ask_entry_tap', 'ask_sheet_submit', 'ask_share_opened', 'ask_link_landed',
  'ask_link_login', 'ask_viewed', 'ask_answered', 'ask_result_viewed', 'ask_requester_decision',
])

export async function recordAskEvent(e: {
  name: string; requestId?: string | null; recipientKind?: string | null
  userId?: string | null; telegramId?: number | null; props?: Record<string, unknown>
}): Promise<void> {
  try {
    await sql`
      insert into ask_events ${sql({
        name: e.name,
        request_id: e.requestId ?? null,
        recipient_kind: e.recipientKind ?? null,
        user_id: e.userId ?? null,
        telegram_id: e.telegramId ?? null,
        props: sql.json((e.props ?? {}) as never),
      })}`
  } catch (err) {
    console.error('[asks] event insert failed:', (err as Error)?.message ?? err)
  }
}

/** Validate a client event body; null when it isn't one we accept. */
export function parseClientEvent(body: unknown): { name: string; requestId: string | null; recipientKind: string | null; props: Record<string, unknown> } | null {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.name !== 'string' || !CLIENT_ASK_EVENTS.has(b.name)) return null
  let props: Record<string, unknown> = {}
  if (b.props && typeof b.props === 'object' && !Array.isArray(b.props)) {
    if (JSON.stringify(b.props).length > 2000) return null
    props = b.props as Record<string, unknown>
  }
  return {
    name: b.name,
    requestId: isUuid(b.requestId) ? b.requestId : null,
    recipientKind: b.recipientKind === 'member' || b.recipientKind === 'link' ? b.recipientKind : null,
    props,
  }
}

// ── Requester side ──────────────────────────────────────────────────────────

type ViewerUser = { id: string; name: string; gender: string; age: number; account_status: string }

async function loadUser(userId: string): Promise<ViewerUser | null> {
  const [u] = await sql<ViewerUser[]>`
    select id, name, gender, age, account_status from users
    where id = ${userId} and deleted_at is null and banned_at is null`
  return u ?? null
}

export async function askConfigFor(userId: string): Promise<{ enabled: boolean }> {
  const u = await loadUser(userId)
  return { enabled: Boolean(u && canUseAskFriend(u)) }
}

export type AskFriend = { id: string; name: string; photoUrl: string | null; lastInteractionAt: string }

/** Member friends (deviation 4 of the spec): women who exchanged an ask with
 *  the user either way, or who joined from her link. Last interaction first. */
export async function listFriends(userId: string, limit = 20): Promise<AskFriend[]> {
  const rows = await sql<{ id: string; name: string; photo_url: string | null; last_at: string }[]>`
    with interactions as (
      select ar.recipient_id as friend_id, coalesce(ar.answered_at, r.created_at) as at
      from ask_requests r join ask_recipients ar on ar.request_id = r.id
      where r.requester_id = ${userId} and ar.recipient_id is not null
        and (ar.kind = 'member' or ar.answered_at is not null)
      union all
      select r.requester_id, coalesce(ar.answered_at, r.created_at)
      from ask_recipients ar join ask_requests r on r.id = ar.request_id
      where ar.recipient_id = ${userId} and (ar.kind = 'member' or ar.answered_at is not null)
      union all
      select u.id, u.created_at from users u where u.invited_by = ${userId}
      union all
      -- Whoever answered her share link (by Telegram id): friends whether they
      -- already had an account or signed up afterwards. Answered, not just opened,
      -- so a stranger tapping a link posted in a group doesn't become a friend.
      select u.id, coalesce(ar.answered_at, ar.seen_at, r.created_at)
      from ask_requests r join ask_recipients ar on ar.request_id = r.id
      join users u on u.telegram_id = ar.advisor_tg_id
      where r.requester_id = ${userId} and ar.kind = 'link' and ar.advisor_tg_id is not null
        and ar.answered_at is not null
      union all
      -- …and the other way round: she answered someone else's share link.
      select r.requester_id, coalesce(ar.answered_at, ar.seen_at, r.created_at)
      from ask_recipients ar join ask_requests r on r.id = ar.request_id
      join users me on me.id = ${userId}
      where ar.kind = 'link' and ar.advisor_tg_id = me.telegram_id and ar.answered_at is not null
    )
    select u.id, u.name, ${primaryPhoto(sql`u.id`)} as photo_url, max(i.at) as last_at
    from interactions i join users u on u.id = i.friend_id
    where u.id <> ${userId} and u.gender = 'woman' and u.age > 0
      and u.deleted_at is null and u.banned_at is null
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = u.id and b.blocked_id = ${userId})
           or (b.blocker_id = ${userId} and b.blocked_id = u.id))
    group by u.id
    order by last_at desc
    limit ${limit}`
  return rows.map((r) => ({ id: r.id, name: r.name, photoUrl: r.photo_url, lastInteractionAt: r.last_at }))
}

type SummaryRow = {
  id: string; target_id: string; target_name: string; target_photo: string | null; question: AskQuestion
  status: AskStatus; created_at: string; expires_at: string
  total: number; answered: number; yes: number; unsure: number; no: number
}

async function loadSummaries(where: ReturnType<typeof sql>): Promise<SummaryRow[]> {
  return sql<SummaryRow[]>`
    select r.id, r.target_id, t.name as target_name, ${primaryPhoto(sql`t.id`)} as target_photo,
           r.question, ${effStatus()} as status, r.created_at, r.expires_at,
           count(ar.id)::int as total, count(ar.verdict)::int as answered,
           (count(*) filter (where ar.verdict = 'yes'))::int as yes,
           (count(*) filter (where ar.verdict = 'unsure'))::int as unsure,
           (count(*) filter (where ar.verdict = 'no'))::int as no
    from ask_requests r
    join users t on t.id = r.target_id
    left join ask_recipients ar on ar.request_id = r.id
    where ${where}
    group by r.id, t.id
    order by r.created_at desc`
}

const toSummary = (r: SummaryRow): AskSummary => ({
  id: r.id, targetId: r.target_id, targetName: r.target_name, targetPhotoUrl: r.target_photo,
  question: r.question, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at,
  total: r.total, answered: r.answered, yes: r.yes, unsure: r.unsure, no: r.no,
})

/** Open asks plus those closed/expired in the last 7 days. */
export async function listMyAsks(userId: string): Promise<AskSummary[]> {
  const rows = await loadSummaries(sql`
    r.requester_id = ${userId}
    and (r.status = 'open' or coalesce(r.closed_at, r.expires_at) > now() - interval '7 days')`)
  return rows.map(toSummary)
}

export type CreateAskInput = { targetId: unknown; question: unknown; memberIds: unknown; linkCount: unknown }

/** The target a requester may ask about: live, finished, not blocked either way. */
async function targetIsAskable(requesterId: string, targetId: string): Promise<boolean> {
  const [t] = await sql`
    select 1 from users u
    where u.id = ${targetId} and u.id <> ${requesterId}
      and u.deleted_at is null and u.banned_at is null and u.is_active = true
      and u.account_status = 'active' and u.age > 0 and u.paused_at is null
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${requesterId} and b.blocked_id = u.id)
           or (b.blocker_id = u.id and b.blocked_id = ${requesterId}))`
  return Boolean(t)
}

export async function createAsk(
  requesterId: string,
  input: CreateAskInput,
): Promise<{ ok: true; ask: AskSummary; links: string[] } | Fail> {
  const { targetId, question, memberIds, linkCount } = input
  const members = Array.isArray(memberIds) ? memberIds : memberIds === undefined ? [] : null
  const links = linkCount === undefined ? 0 : linkCount
  if (
    !isUuid(targetId) || !ASK_QUESTIONS.includes(question as AskQuestion) || !members ||
    !members.every(isUuid) || new Set(members).size !== members.length ||
    !Number.isInteger(links) || (links as number) < 0 || (links as number) > ASK_MAX_RECIPIENTS
  ) return fail(400, 'invalid_ask')
  const memberList = members as string[]
  const linkN = links as number
  const total = memberList.length + linkN
  if (total < 1 || total > ASK_MAX_RECIPIENTS) return fail(400, 'invalid_ask')

  const me = await loadUser(requesterId)
  if (!me || !canUseAskFriend(me)) return fail(403, 'not_allowed')
  if (!(await targetIsAskable(requesterId, targetId))) return fail(400, 'invalid_target')

  if (memberList.length) {
    const friends = new Set((await listFriends(requesterId, 1000)).map((f) => f.id))
    if (memberList.some((id) => !friends.has(id) || id === targetId)) return fail(400, 'invalid_member')
    const [{ blocked }] = await sql<{ blocked: number }[]>`
      select count(*)::int as blocked from blocks b
      where (b.blocker_id = any(${memberList}::uuid[]) and b.blocked_id = ${targetId})
         or (b.blocked_id = any(${memberList}::uuid[]) and b.blocker_id = ${targetId})`
    if (blocked > 0) return fail(400, 'invalid_member')
  }

  const tokens = Array.from({ length: linkN }, newAskToken)
  const result = await sql.begin(async (tx) => {
    // One create at a time per requester, so the caps below can't be raced.
    await tx`select pg_advisory_xact_lock(hashtextextended(${requesterId}, 711))`
    const [existing] = await tx<{ id: string }[]>`
      select r.id from ask_requests r
      where r.requester_id = ${requesterId} and r.target_id = ${targetId}
        and r.status = 'open' and r.expires_at > now()
      limit 1`
    if (existing) return fail(409, 'ask_exists', { askId: existing.id })

    const [{ used }] = await tx<{ used: number }[]>`
      select count(ar.id)::int as used from ask_requests r
      join ask_recipients ar on ar.request_id = r.id
      where r.requester_id = ${requesterId} and r.target_id = ${targetId}`
    if (used + total > ASK_MAX_RECIPIENTS) return fail(429, 'ask_limit', { reason: 'target' })

    const [{ open, day }] = await tx<{ open: number; day: number }[]>`
      select (count(*) filter (where status = 'open' and expires_at > now()))::int as open,
             (count(*) filter (where created_at > now() - interval '24 hours'))::int as day
      from ask_requests where requester_id = ${requesterId}`
    if (open >= ASK_MAX_OPEN) return fail(429, 'ask_limit', { reason: 'open' })
    if (day >= ASK_MAX_PER_DAY) return fail(429, 'ask_limit', { reason: 'daily' })

    const [req] = await tx<{ id: string }[]>`
      insert into ask_requests ${tx({
        requester_id: requesterId, target_id: targetId, question: question as string,
        expires_at: new Date(Date.now() + ASK_TTL_MS).toISOString(),
      })}
      returning id`
    const rows = [
      ...memberList.map((id) => ({ request_id: req.id, kind: 'member', recipient_id: id, token_hash: null })),
      ...tokens.map((tok) => ({ request_id: req.id, kind: 'link', recipient_id: null, token_hash: hashAskToken(tok) })),
    ]
    const inserted = await tx<{ id: string; recipient_id: string | null }[]>`
      insert into ask_recipients ${tx(rows)} returning id, recipient_id`
    return { ok: true as const, id: req.id, inserted }
  })
  if (!result.ok) return result as Fail

  // Member friends get a bot DM; fire-and-forget (never delays the response).
  const memberRows = result.inserted.filter((r) => r.recipient_id)
  if (memberRows.length) {
    void (async () => {
      const users = await sql<{ id: string; telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null }[]>`
        select id, telegram_id, allows_write_to_pm, locale from users
        where id = any(${memberRows.map((r) => r.recipient_id)}::uuid[])`
      await Promise.all(memberRows.map((r) => {
        const u = users.find((x) => x.id === r.recipient_id)
        return u ? notifyAskMember(u, me.name, r.id) : false
      }))
    })().catch((err) => console.error('[asks] member notify failed:', (err as Error)?.message ?? err))
  }

  void recordAskEvent({
    name: 'ask_created', requestId: result.id, userId: requesterId,
    props: { question, member_count: memberList.length, link_count: linkN },
  })

  const [summary] = await loadSummaries(sql`r.id = ${result.id}`)
  return { ok: true, ask: toSummary(summary), links: tokens.map(askLink) }
}

type DetailRecipientRow = {
  id: string; kind: 'member' | 'link'; recipient_id: string | null; advisor_tg_id: number | null
  advisor_name: string | null; member_name: string | null; seen_at: string | null
  verdict: AskVerdict | null; note: string | null; answered_at: string | null
  reminded_at: string | null; foreign_open_at: string | null; created_at: string
  advisor_gender: 'female' | 'male' | null; claimer_gender: string | null; claimer_age: number | null
  claimer_gone?: boolean | null
}

function canRemind(r: DetailRecipientRow, ask: { status: AskStatus; createdAt: string }, now = Date.now()): boolean {
  return ask.status === 'open' && !r.answered_at && !r.reminded_at &&
    now - new Date(ask.createdAt).getTime() >= ASK_REMIND_AFTER_MS &&
    (r.kind === 'member' ? Boolean(r.recipient_id) : r.advisor_tg_id !== null) &&
    // A member who has since deleted (or been banned) gets no more DMs.
    !r.claimer_gone &&
    // Never remind a man: a finished member's own gender decides, else the declared one.
    (r.claimer_age && r.claimer_age > 0 ? r.claimer_gender === 'woman' : r.advisor_gender !== 'male')
}

/** Requester-only detail; null when it isn't hers (or doesn't exist). */
export async function getAskDetail(userId: string, askId: string): Promise<AskDetail | null> {
  if (!isUuid(askId)) return null
  const [s] = await loadSummaries(sql`r.id = ${askId} and r.requester_id = ${userId}`)
  if (!s) return null
  const summary = toSummary(s)
  const [[target], recs] = await Promise.all([
    sql<{ id: string; name: string; age: number }[]>`select id, name, age from users where id = ${s.target_id}`,
    sql<DetailRecipientRow[]>`
      select ar.id, ar.kind, ar.recipient_id, ar.advisor_tg_id, ar.advisor_name, m.name as member_name,
             ar.seen_at, ar.verdict, ar.note, ar.answered_at, ar.reminded_at, ar.foreign_open_at, ar.created_at,
             ar.advisor_gender, m.gender::text as claimer_gender, m.age as claimer_age,
             (m.deleted_at is not null or m.banned_at is not null) as claimer_gone
      from ask_recipients ar left join users m on m.id = ar.recipient_id
      where ar.request_id = ${askId}
      order by ar.created_at asc, ar.id asc`,
  ])
  return {
    ...summary,
    target: { id: target.id, name: target.name, age: target.age, photoUrl: s.target_photo },
    recipients: recs.map((r) => ({
      id: r.id,
      kind: r.kind,
      displayName: r.kind === 'member' ? r.member_name : r.advisor_name,
      status: r.answered_at ? 'answered' : r.seen_at ? 'seen' : 'unseen',
      verdict: r.verdict,
      note: r.note,
      answeredAt: r.answered_at,
      canRemind: canRemind(r, summary),
      foreignOpen: r.foreign_open_at !== null,
    })),
  }
}

export async function remindRecipient(userId: string, askId: string, recipientId: string): Promise<{ ok: true } | Fail> {
  if (!isUuid(askId) || !isUuid(recipientId)) return fail(404, 'ask_not_found')
  const [row] = await sql<(DetailRecipientRow & { status: AskStatus; ask_created_at: string; requester_name: string })[]>`
    select ar.id, ar.kind, ar.recipient_id, ar.advisor_tg_id, ar.advisor_name, null as member_name,
           ar.seen_at, ar.verdict, ar.note, ar.answered_at, ar.reminded_at, ar.foreign_open_at, ar.created_at,
           ar.advisor_gender, m.gender::text as claimer_gender, m.age as claimer_age,
           (m.deleted_at is not null or m.banned_at is not null) as claimer_gone,
           ${effStatus()} as status, r.created_at as ask_created_at, rq.name as requester_name
    from ask_recipients ar
    join ask_requests r on r.id = ar.request_id
    join users rq on rq.id = r.requester_id
    left join users m on m.id = ar.recipient_id
    where ar.id = ${recipientId} and r.id = ${askId} and r.requester_id = ${userId}`
  if (!row) return fail(404, 'ask_not_found')
  if (row.status !== 'open') return fail(409, 'ask_closed')
  if (!canRemind(row, { status: row.status, createdAt: row.ask_created_at })) return fail(409, 'cannot_remind')

  const claimed = await sql`
    update ask_recipients set reminded_at = now()
    where id = ${recipientId} and reminded_at is null and answered_at is null
    returning id`
  if (!claimed.length) return fail(409, 'cannot_remind')

  // Member → her users row; claimed link → the Telegram id that claimed it
  // (best-effort: fails quietly if that account never started the bot).
  let dm: { telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null } | undefined
  if (row.recipient_id) {
    ;[dm] = await sql<{ telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null }[]>`
      select telegram_id, allows_write_to_pm, locale from users where id = ${row.recipient_id}`
  }
  if (!dm && row.advisor_tg_id) dm = { telegram_id: row.advisor_tg_id, allows_write_to_pm: null, locale: null }
  // A link advisor may have no users row: her button reopens the link by recipient id.
  if (dm) void notifyAskRemind(dm, row.requester_name, recipientId, row.kind === 'link' ? 'ask_link' : 'ask')
  return { ok: true }
}

/** The requester liked/passed/messaged the target: her open asks on them close.
 *  Never throws (a swipe must not fail over this). */
export async function closeAsksOnDecision(requesterId: string, targetId: string, reason: 'liked' | 'passed' | 'messaged'): Promise<void> {
  try {
    const closed = await sql<{ id: string }[]>`
      update ask_requests set status = 'closed', closed_at = now(), closed_reason = ${reason}
      where requester_id = ${requesterId} and target_id = ${targetId} and status = 'open'
      returning id`
    for (const c of closed) {
      void recordAskEvent({ name: 'ask_requester_decision', requestId: c.id, userId: requesterId, props: { decision: reason === 'liked' ? 'like' : reason === 'passed' ? 'pass' : 'message', source: reason === 'messaged' ? 'chat' : 'swipe' } })
    }
  } catch (err) {
    console.error('[asks] close on decision failed:', (err as Error)?.message ?? err)
  }
}

/** A block between two users closes asks either one opened about the other. Never throws. */
export async function closeAsksOnBlock(a: string, b: string): Promise<void> {
  try {
    await sql`
      update ask_requests set status = 'closed', closed_at = now(), closed_reason = 'blocked'
      where status = 'open'
        and ((requester_id = ${a} and target_id = ${b}) or (requester_id = ${b} and target_id = ${a}))`
  } catch (err) {
    console.error('[asks] close on block failed:', (err as Error)?.message ?? err)
  }
}

/** Discovery badge data: the viewer's own open asks on these candidates. */
export async function openAsksForCandidates(
  requesterId: string,
  candidateIds: string[],
): Promise<Map<string, { id: string; status: 'open'; answered: number; total: number; yes: number; question: AskQuestion }>> {
  const out = new Map<string, { id: string; status: 'open'; answered: number; total: number; yes: number; question: AskQuestion }>()
  if (!candidateIds.length) return out
  const rows = await sql<{ id: string; target_id: string; question: AskQuestion; answered: number; total: number; yes: number }[]>`
    select r.id, r.target_id, r.question, count(ar.id)::int as total, count(ar.verdict)::int as answered,
           (count(*) filter (where ar.verdict = 'yes'))::int as yes
    from ask_requests r left join ask_recipients ar on ar.request_id = r.id
    where r.requester_id = ${requesterId} and r.target_id = any(${candidateIds}::uuid[])
      and r.status = 'open' and r.expires_at > now()
    group by r.id`
  for (const r of rows) {
    out.set(r.target_id, { id: r.id, status: 'open', answered: r.answered, total: r.total, yes: r.yes, question: r.question })
  }
  return out
}

// ── Recipient side ──────────────────────────────────────────────────────────

type RecRow = {
  id: string; request_id: string; kind: 'member' | 'link'; recipient_id: string | null
  advisor_tg_id: number | null; advisor_name: string | null; advisor_gender: 'female' | 'male' | null
  seen_at: string | null; verdict: AskVerdict | null; note: string | null; answered_at: string | null
  requester_id: string; target_id: string; question: AskQuestion; status: AskStatus
  requester_name: string; target_gone: boolean
}

async function loadRecipient(where: ReturnType<typeof sql>): Promise<RecRow | null> {
  const [row] = await sql<RecRow[]>`
    select ar.id, ar.request_id, ar.kind, ar.recipient_id, ar.advisor_tg_id, ar.advisor_name, ar.advisor_gender,
           ar.seen_at, ar.verdict, ar.note, ar.answered_at,
           r.requester_id, r.target_id, r.question, ${effStatus()} as status, rq.name as requester_name,
           (t.deleted_at is not null or t.banned_at is not null or t.paused_at is not null
            or t.is_active = false
            or rq.deleted_at is not null or rq.banned_at is not null) as target_gone
    from ask_recipients ar
    join ask_requests r on r.id = ar.request_id
    join users rq on rq.id = r.requester_id
    join users t on t.id = r.target_id
    where ${where}`
  return row ?? null
}

/** The viewing person: a users row (member, possibly unfinished) and/or a Telegram id. */
type Viewer = {
  userId: string | null; gender: string | null; age: number; telegramId: number | null
  /** Gender we trust from a users row: a finished profile, or a deleted account
   *  (its gender snapshot survives the wipe). null = must self-declare. */
  knownGender: string | null
}

async function viewerByTelegram(tgId: number): Promise<Viewer & { banned: boolean }> {
  const [u] = await sql<{ id: string; gender: string; age: number; banned_at: string | null; deleted_at: string | null }[]>`
    select id, gender, age, banned_at, deleted_at from users where telegram_id = ${tgId}
    order by (deleted_at is null) desc limit 1`
  if (!u) return { userId: null, gender: null, age: 0, telegramId: tgId, banned: false, knownGender: null }
  if (u.deleted_at) {
    // Not a member any more, but the account's gender still decides.
    return { userId: null, gender: null, age: 0, telegramId: tgId, banned: Boolean(u.banned_at), knownGender: u.gender }
  }
  return {
    userId: u.id, gender: u.gender, age: u.age, telegramId: tgId, banned: Boolean(u.banned_at),
    knownGender: u.age > 0 ? u.gender : null,
  }
}

type Gate = 'closed' | 'not_for_you' | 'need_gender' | 'ready'

/** Female check: a finished member's own gender; anyone else (no users row,
 *  or a signup still at the default gender) declares it once on the link. */
async function gate(rec: RecRow, v: Viewer): Promise<Gate> {
  if (rec.status !== 'open' || rec.target_gone) return 'closed'
  if (v.userId && (v.userId === rec.requester_id || v.userId === rec.target_id)) return 'not_for_you'
  if (v.knownGender !== null) {
    if (v.knownGender !== 'woman') return 'not_for_you'
  } else if (rec.advisor_gender === null) {
    return 'need_gender'
  } else if (rec.advisor_gender !== 'female') {
    return 'not_for_you'
  }
  const blockerId = v.userId ?? rec.recipient_id
  if (blockerId) {
    const [b] = await sql`
      select 1 from blocks
      where blocker_id = ${blockerId} and blocked_id in (${rec.target_id}, ${rec.requester_id})
         or blocked_id = ${blockerId} and blocker_id in (${rec.target_id}, ${rec.requester_id})
      limit 1`
    if (b) return 'closed'
  }
  return 'ready'
}

async function buildView(rec: RecRow, v: Viewer): Promise<RecipientView> {
  const [[target], photos, [requester]] = await Promise.all([
    sql<{ name: string; age: number; location: string | null; bio: string | null; interests: string[] | null }[]>`
      select name, age, location, bio, interests from users where id = ${rec.target_id}`,
    sql<{ url: string }[]>`select url from user_photos where user_id = ${rec.target_id} order by position asc`,
    sql<{ photo: string | null }[]>`select ${primaryPhoto(sql`${rec.requester_id}::uuid`)} as photo`,
  ])
  return {
    recipientId: rec.id,
    requesterName: rec.requester_name,
    requesterPhotoUrl: requester?.photo ?? null,
    question: rec.question,
    status: rec.status,
    watermark: rec.id.replace(/-/g, '').slice(0, 6),
    isMember: Boolean(v.userId) && v.age > 0,
    // Deliberately no id, telegram id, username or distance.
    profile: {
      name: target.name, age: target.age, location: target.location ?? null, bio: target.bio ?? null,
      interests: target.interests ?? [], photos: photos.map((_, i) => askPhotoUrl(rec.id, i)),
    },
    myAnswer: rec.answered_at && rec.verdict
      ? {
          verdict: rec.verdict, note: rec.note, answeredAt: rec.answered_at,
          editableUntil: new Date(new Date(rec.answered_at).getTime() + ASK_EDIT_WINDOW_MS).toISOString(),
        }
      : null,
  }
}

async function markSeen(rec: RecRow, v: Viewer): Promise<void> {
  if (rec.seen_at) return
  const r = await sql`update ask_recipients set seen_at = now() where id = ${rec.id} and seen_at is null returning id`
  if (r.length) {
    void recordAskEvent({ name: 'ask_viewed', requestId: rec.request_id, recipientKind: rec.kind, userId: v.userId, telegramId: v.telegramId })
  }
}

/** A view that says only "it's over" (no profile, no requester). */
function closedView(rec: RecRow, status: AskStatus): RecipientView {
  return {
    recipientId: rec.id, requesterName: '', requesterPhotoUrl: null, question: rec.question,
    status: status === 'open' ? 'closed' : status, watermark: '', isMember: true,
    profile: { name: '', age: 0, location: null, bio: null, interests: [], photos: [] },
    myAnswer: null,
  }
}

/** Member recipient path (`/asks/for-me/:recipientId`): her users row is the
 *  recipient, or her Telegram account claimed the link. */
async function memberRecipient(userId: string, recipientId: string): Promise<{ rec: RecRow; viewer: Viewer } | null> {
  if (!isUuid(recipientId)) return null
  const rec = await loadRecipient(sql`ar.id = ${recipientId}`)
  if (!rec) return null
  const [u] = await sql<{ id: string; gender: string; age: number; telegram_id: number | null }[]>`
    select id, gender, age, telegram_id from users where id = ${userId}`
  if (!u) return null
  const mine = rec.recipient_id === u.id || (rec.advisor_tg_id !== null && rec.advisor_tg_id === u.telegram_id)
  if (!mine) return null
  return { rec, viewer: { userId: u.id, gender: u.gender, age: u.age, telegramId: u.telegram_id, knownGender: u.age > 0 ? u.gender : null } }
}

export async function getRecipientViewForMember(userId: string, recipientId: string): Promise<{ ok: true; view: RecipientView } | Fail> {
  const found = await memberRecipient(userId, recipientId)
  if (!found) return fail(404, 'ask_not_found')
  const g = await gate(found.rec, found.viewer)
  if (g === 'not_for_you') return fail(403, 'not_for_you')
  if (g === 'need_gender') return fail(403, 'need_gender')
  if (g === 'closed') return { ok: true, view: closedView(found.rec, found.rec.status) }
  await markSeen(found.rec, found.viewer)
  return { ok: true, view: await buildView({ ...found.rec, seen_at: found.rec.seen_at ?? new Date().toISOString() }, found.viewer) }
}

export function parseAnswer(body: unknown): { verdict: AskVerdict; note: string | null } | null {
  const b = (body ?? {}) as Record<string, unknown>
  if (!ASK_VERDICTS.includes(b.verdict as AskVerdict)) return null
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return null
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if ([...note].length > ASK_NOTE_MAX) return null
  return { verdict: b.verdict as AskVerdict, note: note || null }
}

async function saveAnswer(rec: RecRow, v: Viewer, answer: { verdict: AskVerdict; note: string | null }): Promise<{ ok: true } | Fail> {
  const first = !rec.answered_at
  const updated = await sql<{ id: string }[]>`
    update ask_recipients set
      verdict = ${answer.verdict}, note = ${answer.note},
      answered_at = coalesce(answered_at, now()), seen_at = coalesce(seen_at, now())
    where id = ${rec.id}
      and (answered_at is null or answered_at > now() - ${`${ASK_EDIT_WINDOW_MS / 1000} seconds`}::interval)
      and exists (
        select 1 from ask_requests r
        where r.id = ask_recipients.request_id and r.status = 'open' and r.expires_at > now())
    returning id`
  if (!updated.length) {
    const [open] = await sql`
      select 1 from ask_requests where id = ${rec.request_id} and status = 'open' and expires_at > now()`
    return fail(409, open ? 'answer_locked' : 'ask_closed')
  }
  if (first) {
    void recordAskEvent({
      name: 'ask_answered', requestId: rec.request_id, recipientKind: rec.kind, userId: v.userId, telegramId: v.telegramId,
      props: { verdict: answer.verdict, has_note: Boolean(answer.note) },
    })
    void notifyRequesterOfAnswer(rec.request_id).catch((err) =>
      console.error('[asks] answer notify failed:', (err as Error)?.message ?? err))
  }
  return { ok: true }
}

export async function answerAsMember(userId: string, recipientId: string, body: unknown): Promise<{ ok: true } | Fail> {
  const answer = parseAnswer(body)
  if (!answer) return fail(400, 'invalid_answer')
  const found = await memberRecipient(userId, recipientId)
  if (!found) return fail(404, 'ask_not_found')
  const g = await gate(found.rec, found.viewer)
  if (g === 'closed') return fail(409, 'ask_closed')
  if (g !== 'ready') return fail(403, g)
  return saveAnswer(found.rec, found.viewer, answer)
}

/** "<friend> gave her opinion" to the requester, at most once an hour per ask
 *  (the job sends a catch-up for answers that landed inside the hour). */
export async function notifyRequesterOfAnswer(askId: string): Promise<boolean> {
  const gap = `${ASK_ANSWER_NOTIFY_GAP_MS / 1000} seconds`
  const [claim] = await sql<{ requester_id: string }[]>`
    update ask_requests set last_answer_notified_at = now()
    where id = ${askId} and status = 'open' and expires_at > now()
      and (last_answer_notified_at is null or last_answer_notified_at <= now() - ${gap}::interval)
    returning requester_id`
  if (!claim) return false
  const [[u], [latest]] = await Promise.all([
    sql<{ telegram_id: number | null; allows_write_to_pm: boolean | null; locale: string | null }[]>`
      select telegram_id, allows_write_to_pm, locale from users where id = ${claim.requester_id}`,
    sql<{ name: string | null }[]>`
      select coalesce(m.name, ar.advisor_name) as name
      from ask_recipients ar left join users m on m.id = ar.recipient_id and m.age > 0
      where ar.request_id = ${askId} and ar.answered_at is not null
      order by ar.answered_at desc limit 1`,
  ])
  if (!u) return false
  return notifyAskAnswered(u, latest?.name ?? null, askId)
}

// ── Link (public, by token) ─────────────────────────────────────────────────

export type LinkCaller = { tg: TelegramUser } | null

/** `r_<recipientUuid>` in place of a link token → that recipient id. */
function recipientIdRef(token: unknown): string | null {
  if (typeof token !== 'string' || !token.startsWith('r_')) return null
  const id = token.slice(2)
  return isUuid(id) ? id : null
}

async function recordClaimAttribution(tgId: number): Promise<void> {
  try {
    await sql`
      insert into join_tag_starts (tag, telegram_id, existing_user)
      values ('friend_ask', ${tgId}, false)
      on conflict do nothing`
  } catch (err) {
    console.error('[asks] join tag start failed:', (err as Error)?.message ?? err)
  }
}

/** Resolve a link for the landing page (no caller) or for a signed-in Telegram
 *  account, claiming the link on first open. `gender` declares the caller's
 *  gender (non-members, once). */
export async function resolveLink(
  token: unknown,
  caller: LinkCaller,
  opts: { gender?: 'female' | 'male' } = {},
): Promise<{ state: LinkState; rec: RecRow | null; viewer: Viewer | null }> {
  const none = (state: LinkState) => ({ state, rec: null, viewer: null })
  const byId = recipientIdRef(token)
  if (!byId && !isAskTokenShape(token)) return none({ state: 'invalid' })
  let rec = byId
    ? await loadRecipient(sql`ar.id = ${byId} and ar.kind = 'link'`)
    : await loadRecipient(sql`ar.token_hash = ${hashAskToken(token as string)}`)
  if (!rec) return none({ state: 'invalid' })
  // `r_<recipientId>` (remind DM button) only reopens an already-claimed link
  // for the account that claimed it: anyone else sees invalid, nothing is
  // claimed and no foreign open is recorded.
  if (byId && (!caller || rec.advisor_tg_id === null || rec.advisor_tg_id !== caller.tg.id)) {
    return none({ state: 'invalid' })
  }
  const isClosed = rec.status !== 'open' || rec.target_gone

  if (!caller) {
    if (isClosed) return none({ state: 'closed' })
    return none({ state: 'landing', requesterName: rec.requester_name, question: rec.question })
  }
  if (isClosed) return none({ state: 'closed' })

  const tg = caller.tg
  const viewer = await viewerByTelegram(tg.id)
  if (viewer.banned) return none({ state: 'not_for_you' })
  // The requester (testing her own link) or the target must never claim it.
  if (viewer.userId && (viewer.userId === rec.requester_id || viewer.userId === rec.target_id)) {
    return none({ state: 'not_for_you' })
  }

  // Never claim for someone who'd be turned away: a finished member who isn't
  // a woman, or an account that already declared male on this link.
  if (viewer.knownGender !== null && viewer.knownGender !== 'woman') return none({ state: 'not_for_you' })
  const [rejected] = await sql`
    select 1 from ask_recipients where id = ${rec.id} and ${tg.id}::bigint = any(rejected_tg_ids)`
  if (rejected) return none({ state: 'not_for_you' })

  // Unknown gender: nothing is claimed until she declares female, so someone who
  // stops at the gender step (or a man) can't lock the link for the real friend.
  if (rec.advisor_tg_id === null && viewer.knownGender === null) {
    if (!opts.gender) return none({ state: 'need_gender', requesterName: rec.requester_name, question: rec.question })
    if (opts.gender === 'male') {
      await sql`
        update ask_recipients set rejected_tg_ids = array_append(rejected_tg_ids, ${tg.id}::bigint)
        where id = ${rec.id} and not (${tg.id}::bigint = any(rejected_tg_ids))`
      return none({ state: 'not_for_you' })
    }
  }
  if (rec.advisor_tg_id === null) {
    const claimed = await sql`
      update ask_recipients set
        advisor_tg_id = ${tg.id}, advisor_name = ${(tg.first_name ?? '').slice(0, 64) || null},
        recipient_id = coalesce(recipient_id, ${viewer.userId})
      where id = ${rec.id} and advisor_tg_id is null
      returning id`
    if (claimed.length && !viewer.userId) await recordClaimAttribution(tg.id)
    rec = (await loadRecipient(sql`ar.id = ${rec.id}`))!
  }
  if (rec.advisor_tg_id !== tg.id) {
    await sql`update ask_recipients set foreign_open_at = coalesce(foreign_open_at, now()) where id = ${rec.id}`
    return none({ state: 'taken' })
  }

  const finishedMember = viewer.knownGender !== null
  if (opts.gender === 'male' && !finishedMember && rec.advisor_gender === null) {
    // Release the claim so the real friend can still open the link; remember him.
    await sql`
      update ask_recipients set
        advisor_tg_id = null, advisor_name = null, recipient_id = null, advisor_gender = null, seen_at = null,
        rejected_tg_ids = array_append(rejected_tg_ids, ${tg.id}::bigint)
      where id = ${rec.id} and advisor_tg_id = ${tg.id} and advisor_gender is null`
    return none({ state: 'not_for_you' })
  }
  if (opts.gender === 'female' && !finishedMember && rec.advisor_gender === null) {
    await sql`update ask_recipients set advisor_gender = 'female' where id = ${rec.id} and advisor_gender is null`
    rec = (await loadRecipient(sql`ar.id = ${rec.id}`))!
  }

  const g = await gate(rec, viewer)
  if (g === 'closed') return { state: { state: 'closed' }, rec, viewer }
  if (g === 'not_for_you') return { state: { state: 'not_for_you' }, rec, viewer }
  if (g === 'need_gender') {
    return { state: { state: 'need_gender', requesterName: rec.requester_name, question: rec.question }, rec, viewer }
  }
  return { state: { state: 'ready', view: await buildView(rec, viewer) }, rec, viewer }
}

/** GET/POST-gender: resolve, then record the first view. */
export async function openLink(token: unknown, caller: LinkCaller, opts: { gender?: 'female' | 'male' } = {}): Promise<LinkState> {
  const { state, rec, viewer } = await resolveLink(token, caller, opts)
  if (state.state === 'ready' && rec && viewer) await markSeen(rec, viewer)
  return state
}

export async function answerByLink(token: unknown, caller: { tg: TelegramUser }, body: unknown): Promise<{ ok: true } | Fail> {
  const answer = parseAnswer(body)
  if (!answer) return fail(400, 'invalid_answer')
  const { state, rec, viewer } = await resolveLink(token, caller)
  if (state.state === 'invalid') return fail(404, 'ask_not_found')
  if (state.state === 'closed') return fail(409, 'ask_closed')
  if (state.state !== 'ready' || !rec || !viewer) return fail(403, state.state)
  return saveAnswer(rec, viewer, answer)
}

/** The request id behind a token (for landing events); null when unknown. */
export async function requestIdForToken(token: unknown, caller: LinkCaller = null): Promise<string | null> {
  const byId = recipientIdRef(token)
  if (byId) {
    if (!caller) return null
    const [r] = await sql<{ request_id: string }[]>`
      select request_id from ask_recipients
      where id = ${byId} and kind = 'link' and advisor_tg_id = ${caller.tg.id}`
    return r?.request_id ?? null
  }
  if (!isAskTokenShape(token)) return null
  const [r] = await sql<{ request_id: string }[]>`
    select request_id from ask_recipients where token_hash = ${hashAskToken(token)}`
  return r?.request_id ?? null
}

// ── Signup attribution ──────────────────────────────────────────────────────

/** A new account whose Telegram id claimed an ask link: invited_by = that
 *  requester, and the claimed recipient rows now point at the account.
 *  Never throws (attribution must not break signup). */
export async function captureAskAttribution(newUserId: string, telegramId: number): Promise<void> {
  try {
    await sql`
      update ask_recipients set recipient_id = ${newUserId}
      where advisor_tg_id = ${telegramId} and recipient_id is null`
    const [first] = await sql<{ request_id: string; requester_id: string; answered_at: string | null }[]>`
      select ar.request_id, r.requester_id, ar.answered_at
      from ask_recipients ar join ask_requests r on r.id = ar.request_id
      where ar.advisor_tg_id = ${telegramId} and r.requester_id <> ${newUserId}
      order by ar.created_at asc
      limit 1`
    if (!first) return
    await sql`update users set invited_by = ${first.requester_id} where id = ${newUserId} and invited_by is null`
    const days = first.answered_at
      ? Math.floor((Date.now() - new Date(first.answered_at).getTime()) / 86_400_000)
      : null
    await recordAskEvent({
      name: 'advisor_converted', requestId: first.request_id, recipientKind: 'link',
      userId: newUserId, telegramId, props: { days_since_answer: days },
    })
  } catch (err) {
    console.error('[asks] signup attribution failed:', (err as Error)?.message ?? err)
  }
}

/** Account deleted (soft): asks about them are deleted at once, their own asks
 *  close. The 15-min job does the same as a backstop. Never throws. */
export async function onAccountDeleted(userId: string): Promise<void> {
  try {
    await sql`delete from ask_requests where target_id = ${userId}`
    await sql`
      update ask_requests set status = 'closed', closed_at = now(), closed_reason = 'requester_gone'
      where requester_id = ${userId} and status = 'open'`
  } catch (err) {
    console.error('[asks] account-deleted cleanup failed:', (err as Error)?.message ?? err)
  }
}

/** The photo proxy (`GET /asks/photo/:recipientId/:index`): the storage path of
 *  the target's index-th photo, only while this recipient could see the ask. */
export async function askPhotoObject(recipientId: string, index: number): Promise<{ url: string } | null> {
  if (!isUuid(recipientId) || !Number.isInteger(index) || index < 0) return null
  const rec = await loadRecipient(sql`ar.id = ${recipientId}`)
  if (!rec) return null
  let viewer: Viewer = { userId: null, gender: null, age: 0, telegramId: rec.advisor_tg_id, knownGender: null }
  if (rec.recipient_id && rec.kind === 'member') {
    const [u] = await sql<{ id: string; gender: string; age: number }[]>`
      select id, gender, age from users where id = ${rec.recipient_id} and deleted_at is null and banned_at is null`
    if (!u) return null
    viewer = { userId: u.id, gender: u.gender, age: u.age, telegramId: rec.advisor_tg_id, knownGender: u.age > 0 ? u.gender : null }
  } else if (rec.kind === 'member' || rec.advisor_tg_id === null) {
    return null
  } else {
    // Non-member link advisor: same viewer the link itself used (a deleted or
    // unfinished account's stored gender counts, as on the answer screen).
    const v = await viewerByTelegram(Number(rec.advisor_tg_id))
    if (v.banned) return null
    viewer = v
  }
  if ((await gate(rec, viewer)) !== 'ready') return null
  const [photo] = await sql<{ url: string }[]>`
    select url from user_photos where user_id = ${rec.target_id}
    order by position asc offset ${index} limit 1`
  return photo ?? null
}

/** The asked-about person as a Discovery card, so she can come back to them from her asks list.
 *  Null when the ask isn't hers, the person is gone/blocked, or she already liked/passed them. */
export async function getAskTargetCard(requesterId: string, askId: string) {
  if (!isUuid(askId)) return null
  const [row] = await sql<{
    id: string; name: string; age: number; bio: string | null; interests: string[] | null
    location: string | null; premium_until: string | null; photos: string[] | null
  }[]>`
    select u.id, u.name, u.age, u.bio, u.interests, u.location, u.premium_until,
           (select array_agg(p.url order by p.position) from user_photos p where p.user_id = u.id) as photos
    from ask_requests r join users u on u.id = r.target_id
    where r.id = ${askId} and r.requester_id = ${requesterId}`
  if (!row || !(await targetIsAskable(requesterId, row.id))) return null
  const [swiped] = await sql`
    select 1 from swipes where swiper_id = ${requesterId} and swiped_id = ${row.id}
      and (direction = 'like' or (direction = 'pass' and created_at > now() - interval '9 days'))`
  if (swiped) return null
  const asks = await openAsksForCandidates(requesterId, [row.id])
  return {
    id: row.id,
    name: row.name,
    age: row.age,
    bio: row.bio,
    interests: row.interests ?? [],
    location: row.location ?? null,
    premium: isPremiumActive(row.premium_until),
    nearby: false,
    photos: row.photos ?? [],
    ...(asks.has(row.id) ? { ask: asks.get(row.id) } : {}),
  }
}
