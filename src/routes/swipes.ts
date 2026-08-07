import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { notifyMatch } from '../bot.js'
import { checkAndCountSwipe } from '../premium/swipeLimit.js'

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

    const limit = await checkAndCountSwipe(req.userId)
    if (limit.blocked) return reply.status(403).send({ error: 'swipe_limit', resetAt: limit.resetAt })
    // Spread into every success payload so the client can flip to the limited
    // screen right after the 20th swipe instead of failing the 21st.
    const swipeLimit = limit.swipeLimit ? { swipeLimit: limit.swipeLimit } : {}

    // Upsert swipe — a later swipe on the same pair (e.g. liking someone you
    // previously passed on, once the pass recycles back into the feed) must
    // overwrite the stored direction rather than silently no-op on conflict.
    const { error: swipeErr } = await db.from('swipes').upsert({
      swiper_id: req.userId,
      swiped_id: targetUserId,
      direction,
      created_at: new Date().toISOString(),
    }, { onConflict: 'swiper_id,swiped_id' })

    if (swipeErr) return reply.status(500).send({ error: 'swipe_failed' })

    if (direction === 'pass') return { matched: false, ...swipeLimit }

    // Check for reverse like
    const { data: reverseSwipe } = await db
      .from('swipes')
      .select('id')
      .eq('swiper_id', targetUserId)
      .eq('swiped_id', req.userId)
      .eq('direction', 'like')
      .single()

    if (!reverseSwipe) return { matched: false, ...swipeLimit }

    // Normalise pair order so UNIQUE(user1_id, user2_id) is deterministic
    const [u1, u2] = [req.userId, targetUserId].sort()

    const { data: match, error: matchErr } = await db
      .from('matches')
      .insert({ user1_id: u1, user2_id: u2 })
      .select('id')
      .single()

    if (matchErr?.code === '23505') return { matched: false, ...swipeLimit } // race — already matched
    if (matchErr) return reply.status(500).send({ error: 'match_failed' })

    // Fetch both users for notification
    const { data: users, error: usersErr } = await db
      .from('users')
      .select('id, name, telegram_id, username, allows_write_to_pm')
      .in('id', [req.userId, targetUserId])

    if (usersErr || !users || users.length < 2) {
      // Match was created, but we can't build the response — return minimal success
      return { matched: true, ...swipeLimit, match: { id: match!.id, user: { id: targetUserId, name: '', telegramId: 0, username: null } } }
    }

    const me = users.find((u: { id: string }) => u.id === req.userId)!
    const them = users.find((u: { id: string }) => u.id === targetUserId)!

    const { data: photos } = await db
      .from('user_photos')
      .select('user_id, url')
      .in('user_id', [req.userId, targetUserId])
      .order('position', { ascending: true })

    const primaryPhoto = (userId: string) =>
      photos?.find((p: { user_id: string; url: string }) => p.user_id === userId)?.url ?? null

    // Fire-and-forget. Telegram rejects DMs from bots the user hasn't granted
    // write access to (never pressed Start / declined the popup), so skip
    // anyone with an explicit false — null means unknown, still worth trying.
    const recipients = [
      { user: me, matchName: them.name, matchPhoto: primaryPhoto(them.id) },
      { user: them, matchName: me.name, matchPhoto: primaryPhoto(me.id) },
    ]
      .filter((r) => r.user.allows_write_to_pm !== false)
      .map((r) => ({ telegramId: r.user.telegram_id, matchName: r.matchName, matchPhoto: r.matchPhoto }))

    if (recipients.length > 0) notifyMatch(recipients).catch(console.error)

    return {
      matched: true,
      ...swipeLimit,
      match: {
        id: match!.id,
        user: { id: them.id, name: them.name, telegramId: them.telegram_id, username: them.username },
      },
    }
  })
}
