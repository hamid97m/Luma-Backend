import type { FastifyInstance } from 'fastify'
import { sql } from '../../db.js'
import { getBotUsername } from '../../bot.js'

type JoinTagRow = {
  tag: string; opened: number; signups: number; completed: number; men: number; women: number
  active_7d: number; paying_users: number; stars_earned: number; toman_earned: number
}

/** One row per tag ever opened. Each aggregate is grouped on its own: joining
 *  users to photos and payments directly would multiply the counts and the money.
 *  - complete = the referral definition: real age and at least one photo.
 *  - Stars earned = Stars that were really charged. A TonPays row also carries
 *    price_stars, but that is the plan's Stars price, so it goes to Toman.
 *  - Gifts count once paid or sent, not when refunded or failed. */
function joinTagStats() {
  return sql<JoinTagRow[]>`
    with opened as (
      select tag, count(*) filter (where not existing_user)::int as opened
      from join_tag_starts
      group by tag
    ), attributed as (
      select u.join_tag, u.gender, u.created_at, u.last_active,
             u.age > 0 and exists (select 1 from user_photos p where p.user_id = u.id) as complete
      from users u where u.join_tag is not null
    ), signups as (
      select join_tag as tag,
             count(*)::int as signups,
             count(*) filter (where complete)::int as completed,
             count(*) filter (where complete and gender = 'man')::int as men,
             count(*) filter (where complete and gender = 'woman')::int as women,
             count(*) filter (where last_active >= created_at + interval '7 days')::int as active_7d
      from attributed
      group by join_tag
    ), payments as (
      select user_id,
             case when provider = 'stars' then price_stars else 0 end as stars,
             case when provider = 'tonpays' then coalesce(tonpays_final_amount, price_toman, 0) else 0 end as toman
      from premium_transactions
      where status = 'paid' and source = 'purchase'
      union all
      select buyer_id, charged_stars, 0
      from gift_transactions
      where status in ('paid', 'sent')
    ), revenue as (
      select u.join_tag as tag,
             count(distinct u.id)::int as paying_users,
             sum(p.stars)::bigint as stars_earned,
             sum(p.toman)::bigint as toman_earned
      from payments p
      join users u on u.id = p.user_id
      where u.join_tag is not null
      group by u.join_tag
    )
    select o.tag, o.opened,
           coalesce(s.signups, 0) as signups,
           coalesce(s.completed, 0) as completed,
           coalesce(s.men, 0) as men,
           coalesce(s.women, 0) as women,
           coalesce(s.active_7d, 0) as active_7d,
           coalesce(r.paying_users, 0) as paying_users,
           coalesce(r.stars_earned, 0) as stars_earned,
           coalesce(r.toman_earned, 0) as toman_earned
    from opened o
    left join signups s on s.tag = o.tag
    left join revenue r on r.tag = o.tag
    order by signups desc, o.opened desc, o.tag asc`
}

export async function adminJoinTagRoutes(app: FastifyInstance) {
  app.get('/join-tags', async (req, reply) => {
    try {
      const rows = await joinTagStats()
      return {
        items: rows.map((r) => ({
          tag: r.tag,
          opened: r.opened,
          signups: r.signups,
          completed: r.completed,
          men: r.men,
          women: r.women,
          active7d: r.active_7d,
          payingUsers: r.paying_users,
          starsEarned: r.stars_earned,
          tomanEarned: r.toman_earned,
        })),
        // Null until the bot has told us its username (only the hint needs it).
        botUsername: getBotUsername(),
      }
    } catch (err) {
      req.log.error({ err }, 'join tags fetch failed')
      return reply.status(500).send({ error: 'join_tags_fetch_failed' })
    }
  })
}
