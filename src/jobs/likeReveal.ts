import { sql } from '../db.js'
import { ensureDailyReveal } from '../likes/reveal.js'

export async function runLikeRevealJob(now = new Date()): Promise<{ considered: number }> {
  // Every live, real woman with at least one incoming like, in the order the old
  // paged (swiper_id, swiped_id) scan first met them. Read errors throw, as before.
  const rows = await sql<{ swiped_id: string }[]>`
    select s.swiped_id
    from swipes s
    join users u on u.id = s.swiped_id
    where s.direction = 'like'
      and u.gender = 'woman'
      and not u.is_seed
      and u.deleted_at is null
      and u.banned_at is null
    group by s.swiped_id
    order by min(s.swiper_id::text), s.swiped_id`
  const ids = rows.map((r) => r.swiped_id)
  for (const id of ids) {
    try {
      await ensureDailyReveal(id, now)
    } catch (err) {
      console.error('like-reveal: ensureDailyReveal failed', { id, err })
    }
  }
  return { considered: ids.length }
}
