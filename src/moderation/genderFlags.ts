import { sql } from '../db.js'

/**
 * Users whose selected gender the AI guesses disagree with — for ADMIN REVIEW
 * ONLY. Nothing here ever rejects, pauses or blocks anyone.
 *
 * Flagged: gender is man/woman, not seed, not deleted, and either the check of
 * their CURRENT main photo has apparent_gender of the other gender, or the
 * latest AI check of their CURRENT name has name_gender of the other gender —
 * with that evidence newer than gender_review_dismissed_at.
 */

export type GenderFlagRow = {
  id: string
  name: string
  gender: string
  age: number
  photo_url: string | null
  banned_at: string | null
  paused_at: string | null
  photo_gender: string | null
  name_gender: string | null
  checked_at: string
}

function flagsQuery(userFilter: ReturnType<typeof sql>) {
  return sql`
    with evidence as (
      select u.id, u.name, u.gender::text as gender, u.age, u.banned_at, u.paused_at,
             mp.url as photo_url,
             pc.apparent_gender as photo_gender, pc.created_at as photo_at,
             nc.name_gender, nc.created_at as name_at,
             coalesce(u.gender_review_dismissed_at, '-infinity'::timestamptz) as dismissed_at
      from users u
      left join lateral (
        select p.id, p.url from user_photos p where p.user_id = u.id order by p.position asc limit 1
      ) mp on true
      left join photo_ai_checks pc on pc.photo_id = mp.id
      left join lateral (
        select t.name_gender, t.created_at from profile_text_checks t
        where t.user_id = u.id and t.field = 'name' and t.source = 'ai' and t.text = u.name
        order by t.created_at desc limit 1
      ) nc on true
      where u.gender in ('man', 'woman') and not u.is_seed and u.deleted_at is null ${userFilter}
    ),
    flagged as (
      select *,
        (photo_gender in ('man', 'woman') and photo_gender <> gender and photo_at > dismissed_at) as photo_flag,
        (name_gender in ('man', 'woman') and name_gender <> gender and name_at > dismissed_at) as name_flag
      from evidence
    )
    select id, name, gender, age, photo_url, banned_at, paused_at, photo_gender, name_gender,
           greatest(case when photo_flag then photo_at end, case when name_flag then name_at end) as checked_at
    from flagged
    where photo_flag or name_flag`
}

export async function listGenderFlags(limit: number, offset: number): Promise<GenderFlagRow[]> {
  return sql<GenderFlagRow[]>`
    select * from (${flagsQuery(sql``)}) f
    order by checked_at desc, id
    limit ${limit} offset ${offset}`
}

export async function countGenderFlags(): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from (${flagsQuery(sql``)}) f`
  return count
}

export type GenderFlag = { photoGender: string | null; nameGender: string | null; checkedAt: string }

/** The user's current gender flag, or null. */
export async function getGenderFlag(userId: string): Promise<GenderFlag | null> {
  const [row] = await sql<GenderFlagRow[]>`${flagsQuery(sql`and u.id = ${userId}`)}`
  return row ? { photoGender: row.photo_gender, nameGender: row.name_gender, checkedAt: row.checked_at } : null
}
