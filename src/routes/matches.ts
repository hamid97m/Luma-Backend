import { FastifyInstance } from 'fastify'
import { sql } from '../db.js'
import { chatGateContext, matchPremiumRequired } from '../premium/chatLimit.js'
import { isPremiumActive } from '../premium/service.js'

interface MatchListRow {
  id: string
  created_at: string
  other_id: string
  name: string
  telegram_id: number
  username: string | null
  age: number | null
  bio: string | null
  icebreaker_prompt: string | null
  icebreaker_answer: string | null
  premium_until: string | null
  photos: string[]
  lm_id: string | null
  lm_body: string | null
  lm_created_at: string | null
  lm_sender_id: string | null
  lm_type: string | null
  unread_count: number
}

export async function matchesRoutes(app: FastifyInstance) {
  app.get('/matches', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const me = req.userId

    // One round trip: the viewer's matches with the other participant, their
    // photos, the latest message and the unread count. User-facing, so matches
    // whose counterpart deleted their account or is blocked (either direction)
    // are hidden. A read failure degrades to an empty list, as before.
    let rows: MatchListRow[] = []
    try {
      rows = await sql<MatchListRow[]>`
        select
          m.id, m.created_at,
          o.id as other_id, o.name, o.telegram_id, o.username, o.age, o.bio,
          o.icebreaker_prompt, o.icebreaker_answer, o.premium_until,
          coalesce(
            (select array_agg(p.url order by p.position) from user_photos p where p.user_id = o.id),
            '{}'
          ) as photos,
          lm.id as lm_id, lm.body as lm_body, lm.created_at as lm_created_at, lm.sender_id as lm_sender_id, lm.type as lm_type,
          (select count(*)::int from messages u
             where u.match_id = m.id and u.sender_id <> ${me} and u.read_at is null) as unread_count
        from matches m
        join users o on o.id = case when m.user1_id = ${me} then m.user2_id else m.user1_id end
        left join lateral (
          select x.id, x.body, x.created_at, x.sender_id, x.type
          from messages x where x.match_id = m.id
          order by x.created_at desc
          limit 1
        ) lm on true
        where (m.user1_id = ${me} or m.user2_id = ${me})
          and o.deleted_at is null
          and not exists (
            select 1 from blocks b
            where (b.blocker_id = ${me} and b.blocked_id = o.id)
               or (b.blocker_id = o.id and b.blocked_id = ${me})
          )
        order by m.created_at desc`
    } catch (err) {
      req.log.error({ err }, 'matches list read failed')
      rows = []
    }

    // One read backs the per-match premium flag (free men and women whose
    // preference includes women get 2 free chats). Non-gated viewers — and an empty list — get an empty context
    // → every match free, and we skip the read when there's nothing to flag.
    const gateCtx = rows.length
      ? await chatGateContext(me)
      : { gated: false, chattedMatchIds: new Set<string>() }

    const matches = rows.map((row) => ({
      id: row.id,
      matchedAt: row.created_at,
      user: {
        id: row.other_id,
        name: row.name,
        telegramId: row.telegram_id,
        username: row.username,
        age: row.age ?? null,
        bio: row.bio ?? null,
        icebreakerPrompt: row.icebreaker_prompt ?? null,
        icebreakerAnswer: row.icebreaker_answer ?? null,
        photos: row.photos ?? [],
        premium: isPremiumActive(row.premium_until ?? null),
      },
      lastMessage: row.lm_id
        ? { body: row.lm_body, createdAt: row.lm_created_at, senderId: row.lm_sender_id, type: row.lm_type ?? 'text' }
        : null,
      unreadCount: row.unread_count ?? 0,
      // Locks the composer client-side for a 4th+ new conversation; the
      // POST /messages 403 is the real enforcement.
      premiumRequired: matchPremiumRequired(gateCtx, row.id),
    }))

    // Newest activity first: a chat bumps to the top when a message lands;
    // matches with no messages yet sort by when the match was made.
    matches.sort((a, b) => {
      const aTime = Date.parse(a.lastMessage?.createdAt ?? a.matchedAt)
      const bTime = Date.parse(b.lastMessage?.createdAt ?? b.matchedAt)
      return bTime - aTime
    })

    return { matches }
  })

  app.get('/matches/unread-count', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const me = req.userId

    // Unread messages from the other side, across matches whose counterpart is
    // neither deleted nor blocked (either direction). Failure → 0, as before.
    try {
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count
        from messages msg
        join matches m on m.id = msg.match_id
        join users o on o.id = case when m.user1_id = ${me} then m.user2_id else m.user1_id end
        where (m.user1_id = ${me} or m.user2_id = ${me})
          and o.deleted_at is null
          and not exists (
            select 1 from blocks b
            where (b.blocker_id = ${me} and b.blocked_id = o.id)
               or (b.blocker_id = o.id and b.blocked_id = ${me})
          )
          and msg.sender_id <> ${me}
          and msg.read_at is null`
      return { count: count ?? 0 }
    } catch (err) {
      req.log.error({ err }, 'unread count read failed')
      return { count: 0 }
    }
  })
}
