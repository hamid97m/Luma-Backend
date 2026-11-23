import { sql } from '../db.js'
import {
  ASK_ANSWER_NOTIFY_GAP_MS, ASK_NUDGE_AFTER_MS, ASK_RETENTION_MS,
} from './config.js'
import { notifyRequesterOfAnswer } from './service.js'
import { notifyAskNudge } from './notify.js'

const NUDGE_BATCH = 200

export type AskJobResult = {
  expired: number; closedGone: number; purged: number; notified: number; nudged: number
}

/**
 * Every 15 min (live mode only — see index.ts):
 *  1. expire open asks past 48h;
 *  2. close asks whose target was banned / requester or target left, or a
 *     block appeared between them; purge at once when the target deleted;
 *  3. purge asks closed more than 30 days ago;
 *  4. catch-up "<friend> gave her opinion" for answers that landed inside the
 *     1-hour notification gap;
 *  5. 3-day "try Luma yourself" nudge to non-member advisors who answered.
 */
export async function runAskJob(now = new Date()): Promise<AskJobResult> {
  const nowIso = now.toISOString()

  const expired = await sql`
    update ask_requests set status = 'expired', closed_at = ${nowIso}, closed_reason = 'expired'
    where status = 'open' and expires_at <= ${nowIso}
    returning id`

  // Target deleted their account: their profile must not linger in anyone's asks.
  const purgedGone = await sql`
    delete from ask_requests r using users t
    where t.id = r.target_id and t.deleted_at is not null
    returning r.id`

  const closedGone = await sql`
    update ask_requests r set status = 'closed', closed_at = ${nowIso},
      closed_reason = case
        when t.banned_at is not null then 'target_gone'
        when q.deleted_at is not null or q.banned_at is not null then 'requester_gone'
        else 'blocked' end
    from users t, users q
    where t.id = r.target_id and q.id = r.requester_id and r.status = 'open'
      and (t.banned_at is not null or q.deleted_at is not null or q.banned_at is not null
        or exists (
          select 1 from blocks b
          where (b.blocker_id = r.requester_id and b.blocked_id = r.target_id)
             or (b.blocker_id = r.target_id and b.blocked_id = r.requester_id)))
    returning r.id`

  const purgedOld = await sql`
    delete from ask_requests
    where status <> 'open' and coalesce(closed_at, expires_at) < ${new Date(now.getTime() - ASK_RETENTION_MS).toISOString()}
    returning id`

  // Analytics events follow the same 30-day retention.
  await sql`delete from ask_events where created_at < ${new Date(now.getTime() - ASK_RETENTION_MS).toISOString()}`

  const pending = await sql<{ id: string }[]>`
    select r.id from ask_requests r
    where r.status = 'open' and r.expires_at > ${nowIso}
      and (r.last_answer_notified_at is null
           or r.last_answer_notified_at <= ${new Date(now.getTime() - ASK_ANSWER_NOTIFY_GAP_MS).toISOString()})
      and exists (
        select 1 from ask_recipients ar
        where ar.request_id = r.id and ar.answered_at is not null
          and ar.answered_at > coalesce(r.last_answer_notified_at, '-infinity'::timestamptz))`
  let notified = 0
  for (const p of pending) {
    try {
      if (await notifyRequesterOfAnswer(p.id)) notified += 1
    } catch (err) {
      console.error('[asks] catch-up notify failed:', (err as Error)?.message ?? err)
    }
  }

  // Claim first (nudged_at), then send: a crash mid-run never double-nudges.
  const nudges = await sql<{ advisor_tg_id: number }[]>`
    update ask_recipients ar set nudged_at = ${nowIso}
    where ar.id in (
      select a.id from ask_recipients a
      where a.kind = 'link' and a.advisor_tg_id is not null and a.nudged_at is null
        and a.advisor_gender = 'female'
        and a.answered_at <= ${new Date(now.getTime() - ASK_NUDGE_AFTER_MS).toISOString()}
        and not exists (select 1 from users u where u.telegram_id = a.advisor_tg_id)
        and not exists (
          select 1 from ask_recipients o
          where o.advisor_tg_id = a.advisor_tg_id and o.nudged_at is not null)
      order by a.answered_at asc
      limit ${NUDGE_BATCH})
    returning ar.advisor_tg_id`
  let nudged = 0
  for (const tgId of new Set(nudges.map((n) => n.advisor_tg_id))) {
    if (await notifyAskNudge({ telegram_id: tgId })) nudged += 1
  }

  return {
    expired: expired.length,
    closedGone: closedGone.length + purgedGone.length,
    purged: purgedOld.length + purgedGone.length,
    notified,
    nudged,
  }
}
