import { sql } from '../db.js'
import * as storage from '../storage.js'

/** Remove every profile photo (DB rows + storage objects) for a user. Used when
 * an account is paused for photo review — the user must re-upload from scratch,
 * and a 0-photo profile is auto-excluded from discovery (user_photos!inner).
 * Best-effort: logs and swallows errors, never throws, so it can't block a pause. */
export async function deleteAllPhotosForUser(userId: string): Promise<void> {
  try {
    const photos = await sql<{ id: string }[]>`select id from user_photos where user_id = ${userId}`
    if (!photos.length) return
    // A failed file delete must not keep the rows (an orphaned file is harmless):
    // log and carry on.
    await storage.remove('profile-photos', photos.map((p) => `${userId}/${p.id}`)).catch((err) => {
      console.error('[moderation] deleteAllPhotosForUser file delete failed:', (err as Error)?.message ?? err)
    })
    await sql`delete from user_photos where user_id = ${userId}`
  } catch (err) {
    console.error('[moderation] deleteAllPhotosForUser failed:', (err as Error)?.message ?? err)
  }
}
