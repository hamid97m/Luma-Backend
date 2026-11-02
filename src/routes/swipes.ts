import { FastifyInstance } from 'fastify'
import { sql, isUuid } from '../db.js'
import { notifyMatch, notifyNewLike } from '../bot.js'
import { checkAndCountSwipe } from '../premium/swipeLimit.js'
import { seedIcebreakers } from '../icebreakers/seed.js'
import { ownerQuestion } from '../icebreakers/question.js'
import type { Locale } from '../i18n/index.js'

export async function swipesRoutes(app: FastifyInstance) {
  app.post('/swipes', {
    config: { rateLimit: { max: 200, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { targetUserId, direction } = req.body as {
      targetUserId: string
      direction: 'like' | 'pass'
    }

    if (targetUserId === req.userId) return reply.status(400).send({ error: 'cannot_swipe_self' })

    // A paused (photo-review) account can't act on the deck until it re-uploads.
    if (req.isPaused) return reply.status(403).send({ error: 'account_paused' })

    // Never act on a missing or soft-deleted target (stale deck cards): the
    // upsert would otherwise record a like against a ghost, which can create
    // an invisible match and DM an account that no longer exists. Checked
    // before the swipe limit so an invalid target never burns quota.
    // A non-uuid id can't be a user (PostgREST answered "no rows"; Postgres would throw).
    const [target] = isUuid(targetUserId)
      ? await sql<{ id: string; deleted_at: string | null }[]>`
          select id, deleted_at from users where id = ${targetUserId}`
      : []
    if (!target || target.deleted_at) {
      return reply.status(404).send({ error: 'target_not_found' })
    }

    const limit = await checkAndCountSwipe(req.userId)
    if (limit.blocked) return reply.status(403).send({ error: 'swipe_limit', resetAt: limit.resetAt })
    // Spread into every success payload so the client can flip to the limited
    // screen right after the 20th swipe instead of failing the 21st.
    const swipeLimit = limit.swipeLimit ? { swipeLimit: limit.swipeLimit } : {}

    // Upsert swipe — a later swipe on the same pair (e.g. liking someone you
    // previously passed on, once the pass recycles back into the feed) must
    // overwrite the stored direction rather than silently no-op on conflict.
    try {
      await sql`
        insert into swipes (swiper_id, swiped_id, direction, created_at)
        values (${req.userId}, ${targetUserId}, ${direction}, ${new Date().toISOString()})
        on conflict (swiper_id, swiped_id)
        do update set direction = excluded.direction, created_at = excluded.created_at`
    } catch {
      // e.g. an invalid direction (enum cast) — PostgREST returned an error here too.
      return reply.status(500).send({ error: 'swipe_failed' })
    }

    if (direction === 'pass') return { matched: false, ...swipeLimit }

    // Check for reverse like
    const [reverseSwipe] = await sql`
      select id from swipes
      where swiper_id = ${targetUserId} and swiped_id = ${req.userId} and direction = 'like'`

    if (!reverseSwipe) {
      // New like, no match yet → nudge the liked user (names the liker; FOMO teaser).
      // A woman is not DMed on this path: her one like DM is sent from
      // ensureDailyReveal (the 18:00 job / her first Likes or discovery read).
      const pair = await sql<{
        id: string; name: string; telegram_id: number; allows_write_to_pm: boolean | null
        locale: Locale | null; gender: string
      }[]>`
        select id, name, telegram_id, allows_write_to_pm, locale, gender
        from users where id = any(${[req.userId, targetUserId]}::uuid[])`
      const me = pair.find((u: { id: string }) => u.id === req.userId)
      const target = pair.find((u: { id: string }) => u.id === targetUserId)
      if (me && target && target.gender !== 'woman' && target.telegram_id > 0 && target.allows_write_to_pm !== false) {
        notifyNewLike(target.telegram_id, me.name, target.locale ?? null).catch(console.error)
      }
      return { matched: false, ...swipeLimit }
    }

    // Normalise pair order so UNIQUE(user1_id, user2_id) is deterministic
    const [u1, u2] = [req.userId, targetUserId].sort()

    let match: { id: string }
    try {
      ;[match] = await sql<{ id: string }[]>`
        insert into matches (user1_id, user2_id) values (${u1}, ${u2}) returning id`
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return { matched: false, ...swipeLimit } // race — already matched
      return reply.status(500).send({ error: 'match_failed' })
    }

    // Post both icebreakers (the earlier liker's first) before responding, so the
    // chat the swiper opens from the match popup already contains them.
    await seedIcebreakers(match.id, [targetUserId, req.userId])

    // Fetch both users for notification
    // Both users and their photos in one round trip (was two sequential reads).
    // A failure keeps the old minimal-response path rather than 500ing the match.
    type MatchUser = {
      id: string; name: string; telegram_id: number; username: string | null
      allows_write_to_pm: boolean | null; locale: Locale | null
      icebreaker_prompt: string | null; icebreaker_answer: string | null
      primary_photo: string | null
    }
    let users: MatchUser[] | null = null
    try {
      users = await sql<MatchUser[]>`
        select u.id, u.name, u.telegram_id, u.username, u.allows_write_to_pm, u.locale,
               u.icebreaker_prompt, u.icebreaker_answer,
               (select p.url from user_photos p where p.user_id = u.id
                order by p.position asc limit 1) as primary_photo
        from users u where u.id = any(${[req.userId, targetUserId]}::uuid[])`
    } catch {
      users = null
    }

    if (!users || users.length < 2) {
      // Match was created, but we can't build the response — return minimal success
      return { matched: true, ...swipeLimit, match: { id: match.id, user: { id: targetUserId, name: '', telegramId: 0, username: null } } }
    }

    const me = users.find((u) => u.id === req.userId)!
    const them = users.find((u) => u.id === targetUserId)!

    const primaryPhoto = (userId: string) => users!.find((u) => u.id === userId)?.primary_photo ?? null

    // Only DM the OTHER user (the earlier liker, who's away from the app). The
    // current swiper already sees the match live in-app (match popup / chat
    // opens), so a "someone liked you" push to themselves is redundant and
    // reads backwards — as if they were the one who got liked.
    // Fire-and-forget. Telegram rejects DMs from bots the user hasn't granted
    // write access to (never pressed Start / declined the popup), so skip
    // anyone with an explicit false — null means unknown, still worth trying.
    const recipients = [
      { user: them, matchName: me.name, matchPhoto: primaryPhoto(me.id) },
    ]
      .filter((r) => r.user.allows_write_to_pm !== false)
      .map((r) => ({
        telegramId: r.user.telegram_id,
        matchName: r.matchName,
        matchPhoto: r.matchPhoto,
        locale: r.user.locale ?? null,
        matchId: match.id,
        // The swiper's own icebreaker, asked in the recipient's language.
        question: ownerQuestion(me, r.user.locale),
      }))

    if (recipients.length > 0) notifyMatch(recipients).catch(console.error)

    return {
      matched: true,
      ...swipeLimit,
      match: {
        id: match.id,
        user: { id: them.id, name: them.name, telegramId: them.telegram_id, username: them.username },
      },
    }
  })
}
