import { db } from '../db.js'
import { ensureDailyReveal } from '../likes/reveal.js'

const PAGE = 1000

export async function runLikeRevealJob(now = new Date()): Promise<{ considered: number }> {
  const ids = new Set<string>()
  let from = 0
  for (;;) {
    const { data, error } = await db
      .from('swipes')
      .select('swiped_id, swiped:users!swipes_swiped_id_fkey(gender, deleted_at, banned_at)')
      .eq('direction', 'like')
      .order('swiper_id', { ascending: true })
      .order('swiped_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data as any[] | null) ?? []
    for (const row of rows) {
      const u = row.swiped
      if (!u || u.gender !== 'woman' || u.deleted_at || u.banned_at) continue
      ids.add(row.swiped_id)
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  for (const id of ids) {
    try {
      await ensureDailyReveal(id, now)
    } catch (err) {
      console.error('like-reveal: ensureDailyReveal failed', { id, err })
    }
  }
  return { considered: ids.size }
}
