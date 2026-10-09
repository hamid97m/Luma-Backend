import { db } from '../db.js'

type IcebreakerUser = { id: string; icebreaker_prompt: string | null; icebreaker_answer: string | null }

/**
 * Post each participant's profile icebreaker (prompt + answer) into a freshly
 * created match as an opening question, owners in `userIds` order. Users
 * without both a prompt and an answer are skipped. Best-effort: logs and
 * swallows every error so match creation never fails because of it, and sends
 * no notification.
 */
export async function seedIcebreakers(matchId: string, userIds: string[]): Promise<void> {
  try {
    const { data, error } = await db
      .from('users')
      .select('id, icebreaker_prompt, icebreaker_answer')
      .in('id', userIds)
    if (error) {
      console.error('[icebreakers] users read failed', error)
      return
    }

    const byId = new Map((data ?? []).map((u: IcebreakerUser) => [u.id, u]))
    const base = Date.now()
    const rows: Record<string, string>[] = []
    for (const id of userIds) {
      const prompt = byId.get(id)?.icebreaker_prompt?.trim()
      const answer = byId.get(id)?.icebreaker_answer?.trim()
      if (!prompt || !answer) continue
      rows.push({
        match_id: matchId,
        sender_id: id,
        type: 'icebreaker',
        body: prompt,
        icebreaker_answer: answer,
        // Consecutive rows 1 ms apart so the thread order is stable.
        created_at: new Date(base + rows.length).toISOString(),
      })
    }
    if (rows.length === 0) return

    const { error: insertError } = await db.from('messages').insert(rows)
    if (insertError) console.error('[icebreakers] insert failed', insertError)
  } catch (err) {
    console.error('[icebreakers] seeding failed', err)
  }
}
