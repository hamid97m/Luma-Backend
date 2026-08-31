import { db } from '../db.js'

/** Remove every profile photo (DB rows + storage objects) for a user. Used when
 * an account is paused for photo review — the user must re-upload from scratch,
 * and a 0-photo profile is auto-excluded from discovery (user_photos!inner).
 * Best-effort: logs and swallows errors, never throws, so it can't block a pause. */
export async function deleteAllPhotosForUser(userId: string): Promise<void> {
  try {
    const { data: photos } = await db
      .from('user_photos')
      .select('id')
      .eq('user_id', userId)
    if (!photos?.length) return
    await db.storage.from('profile-photos').remove(photos.map((p) => `${userId}/${p.id}`))
    await db.from('user_photos').delete().eq('user_id', userId)
  } catch (err) {
    console.error('[moderation] deleteAllPhotosForUser failed:', (err as Error)?.message ?? err)
  }
}
