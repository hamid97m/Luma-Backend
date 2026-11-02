import { FastifyInstance } from 'fastify'
import { sql, db, isUuid } from '../db.js'
import { randomUUID } from 'crypto'
import { fetchTelegramProfilePhoto } from '../bot.js'
import { maybeQualifyReferral } from '../referrals/rewards.js'
import { scheduleMainPhotoCheck } from '../moderation/photoAiCheck.js'

const MAX_PHOTOS = 6

type PhotoSlot = { id: string; position: number }

/** The user's photos, lowest position first. A failed read counts as no photos
 *  (the supabase-js code ignored this error). */
async function photoSlots(userId: string): Promise<PhotoSlot[]> {
  try {
    return await sql<PhotoSlot[]>`
      select id, position from user_photos where user_id = ${userId} order by position asc`
  } catch {
    return []
  }
}

/** A fresh photo lifts a photo-review pause. The `paused_at is not null` guard
 *  makes this a no-op for the common (non-paused) upload; when it does match,
 *  resolve the pending reports that triggered the pause so the count resets and
 *  the user is not immediately re-paused. Best-effort, like the original. */
async function liftPhotoReviewPause(userId: string): Promise<void> {
  try {
    const [resumed] = await sql`
      update users set paused_at = null
      where id = ${userId} and paused_at is not null
      returning id`
    if (resumed) {
      await sql`
        update reports set status = 'resolved_reuploaded', resolved_at = ${new Date().toISOString()}
        where reported_id = ${userId} and status = 'pending'`
    }
  } catch (err) {
    console.error('[photos] lifting photo-review pause failed:', (err as Error)?.message ?? err)
  }
}

/** Ignored-error delete (the supabase-js code never checked it). */
async function deletePhotoRow(photoId: string): Promise<void> {
  await sql`delete from user_photos where id = ${photoId}`.catch((err) =>
    console.error('[photos] delete failed:', (err as Error)?.message ?? err))
}

export async function photosRoutes(app: FastifyInstance) {
  // Get a signed upload URL
  app.post('/profile/me/photos/upload-url', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { contentType, replacePhotoId } = req.body as { contentType: string; replacePhotoId?: string }

    const existing = await photoSlots(req.userId)

    // A replace keeps the net photo count unchanged (the old photo is removed as
    // the new one lands), so the cap must not block it — even at MAX_PHOTOS.
    const isReplace = !!replacePhotoId && existing.some((p) => p.id === replacePhotoId)

    if (!req.isPaused && !isReplace && existing.length >= MAX_PHOTOS) {
      return reply.status(400).send({ error: 'max_photos_reached' })
    }

    const photoId = randomUUID()
    const path = `${req.userId}/${photoId}`

    const { data: signedData, error } = await db.storage
      .from('profile-photos')
      .createSignedUploadUrl(path)

    if (error || !signedData) {
      return reply.status(500).send({ error: 'upload_url_failed' })
    }

    return { uploadUrl: signedData.signedUrl, photoId }
  })

  // Delete a single photo and compact remaining positions
  app.delete('/profile/me/photos/:photoId', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { photoId } = req.params as { photoId: string }

    // A malformed id can't be a photo — 404 instead of a Postgres cast error.
    const [photo] = isUuid(photoId)
      ? await sql<PhotoSlot[]>`
          select id, position from user_photos where id = ${photoId} and user_id = ${req.userId}`
      : []

    if (!photo) return reply.status(404).send({ error: 'photo_not_found' })

    // Don't allow deleting the last remaining photo — a profile must keep at least one.
    // (A failed count read as 0 → 409, as before.)
    const count = await sql<{ count: number }[]>`
      select count(*)::int as count from user_photos where user_id = ${req.userId}`
      .then(([r]) => r.count, () => 0)

    if (count <= 1) return reply.status(409).send({ error: 'last_photo' })

    await deletePhotoRow(photoId)
    await db.storage.from('profile-photos').remove([`${req.userId}/${photoId}`])

    // Shift the photos after the freed slot down by one, lowest first so each
    // move lands on the slot just vacated (UNIQUE(user_id, position)). Errors
    // were ignored before and still are.
    const remaining = await sql<PhotoSlot[]>`
      select id, position from user_photos
      where user_id = ${req.userId} and position > ${photo.position}
      order by position asc`.catch(() => [] as PhotoSlot[])

    for (const p of remaining) {
      await sql`update user_photos set position = ${p.position - 1} where id = ${p.id}`
        .catch((err) => console.error('[photos] compact failed:', (err as Error)?.message ?? err))
    }

    if (photo.position === 0) scheduleMainPhotoCheck(req.userId, req.log)

    return { ok: true }
  })

  // Reorder photos
  app.patch('/profile/me/photos/reorder', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { order } = req.body as { order: string[] }

    // UNIQUE(user_id, position) means writing final positions directly can collide
    // with whatever photo currently holds that slot, so stage through negative
    // positions first to clear all slots before assigning the real ones. Both
    // passes run in one transaction, so a failure (e.g. a malformed id) rolls
    // back instead of leaving a photo at a negative position. The main-photo
    // check still runs on every exit.
    try {
      await sql.begin(async (tx) => {
        for (let i = 0; i < order.length; i++) {
          await tx`update user_photos set position = ${-(i + 1)} where id = ${order[i]} and user_id = ${req.userId!}`
        }
        for (let i = 0; i < order.length; i++) {
          await tx`update user_photos set position = ${i} where id = ${order[i]} and user_id = ${req.userId!}`
        }
      })
      return { ok: true }
    } catch {
      return reply.status(500).send({ error: 'reorder_failed' })
    } finally {
      scheduleMainPhotoCheck(req.userId, req.log)
    }
  })

  // Confirm a photo upload (insert DB row after client uploads to storage)
  app.post('/profile/me/photos/confirm', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { photoId } = req.body as { photoId: string }

    if (!photoId || typeof photoId !== 'string') {
      return reply.status(400).send({ error: 'invalid_photo_id' })
    }

    const existing = await photoSlots(req.userId)

    const count = existing.length
    if (count >= MAX_PHOTOS && !req.isPaused) {
      return reply.status(400).send({ error: 'max_photos_reached' })
    }

    const alreadyExists = existing.some((p) => p.id === photoId)
    if (alreadyExists) {
      return reply.status(409).send({ error: 'photo_already_confirmed' })
    }

    // A paused user re-verifying at the photo cap: evict their oldest photo
    // (lowest position) so the fresh photo can land — and lift the pause —
    // instead of hitting max_photos_reached. Reuse the freed slot's position.
    let nextPosition = count
    if (count >= MAX_PHOTOS && req.isPaused && existing.length > 0) {
      const oldest = existing[0]
      await deletePhotoRow(oldest.id)
      await db.storage.from('profile-photos').remove([`${req.userId}/${oldest.id}`])
      nextPosition = oldest.position
    }

    const path = `${req.userId}/${photoId}`
    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    try {
      await sql`
        insert into user_photos (id, user_id, url, position)
        values (${photoId}, ${req.userId}, ${publicUrl}, ${nextPosition})`
    } catch {
      return reply.status(500).send({ error: 'photo_confirm_failed' })
    }

    await liftPhotoReviewPause(req.userId)

    await maybeQualifyReferral(req.userId)
    if (nextPosition === 0) scheduleMainPhotoCheck(req.userId, req.log)

    return { photo: { id: photoId, url: publicUrl, position: nextPosition } }
  })

  // Replace a photo in place: the client uploads a fresh object (new photoId) to
  // storage first, then calls this to swap it into the old photo's slot. The old
  // row+object are removed and the new row is inserted at the same position, so
  // the net count is unchanged and "main" (position 0) stays put when swapped.
  app.post('/profile/me/photos/:photoId/replace', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { photoId } = req.params as { photoId: string }
    const { newPhotoId } = req.body as { newPhotoId: string }

    if (!newPhotoId || typeof newPhotoId !== 'string' || newPhotoId === photoId) {
      return reply.status(400).send({ error: 'invalid_photo_id' })
    }

    // A malformed id can't be a photo — 404 instead of a Postgres cast error.
    const [oldPhoto] = isUuid(photoId)
      ? await sql<PhotoSlot[]>`
          select id, position from user_photos where id = ${photoId} and user_id = ${req.userId}`
      : []

    if (!oldPhoto) return reply.status(404).send({ error: 'photo_not_found' })

    // Remove the old row + storage object, then insert the fresh one at the freed
    // position (mirrors the paused-eviction path in /confirm).
    await deletePhotoRow(photoId)
    await db.storage.from('profile-photos').remove([`${req.userId}/${photoId}`])

    const path = `${req.userId}/${newPhotoId}`
    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    try {
      await sql`
        insert into user_photos (id, user_id, url, position)
        values (${newPhotoId}, ${req.userId}, ${publicUrl}, ${oldPhoto.position})`
    } catch {
      return reply.status(500).send({ error: 'photo_replace_failed' })
    }

    // A fresh photo lifts a photo-review pause (same as /confirm).
    await liftPhotoReviewPause(req.userId)

    if (oldPhoto.position === 0) scheduleMainPhotoCheck(req.userId, req.log)

    return { photo: { id: newPhotoId, url: publicUrl, position: oldPhoto.position } }
  })

  // Import the user's current Telegram profile photo as a profile photo. Fetches
  // the bytes server-side (via the bot) and uploads them into the same storage
  // path used by the client-upload flow, then inserts a user_photos row —
  // mirroring /confirm's cap check, paused-eviction and pause-lift logic.
  app.post('/profile/me/photos/from-telegram', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const [u] = await sql<{ telegram_id: number }[]>`
      select telegram_id from users where id = ${req.userId}`.catch(() => [])

    if (!u || !u.telegram_id || u.telegram_id <= 0) {
      return reply.status(409).send({ error: 'no_telegram_photo' })
    }

    const existing = await photoSlots(req.userId)

    const count = existing.length
    if (count >= MAX_PHOTOS && !req.isPaused) {
      return reply.status(400).send({ error: 'max_photos_reached' })
    }

    const photo = await fetchTelegramProfilePhoto(u.telegram_id)
    if (!photo) return reply.status(409).send({ error: 'no_telegram_photo' })

    const photoId = randomUUID()

    // A paused user re-verifying at the photo cap: evict their oldest photo
    // (lowest position) so the fresh photo can land — and lift the pause —
    // instead of hitting max_photos_reached. Reuse the freed slot's position.
    let nextPosition = count
    if (count >= MAX_PHOTOS && req.isPaused && existing.length > 0) {
      const oldest = existing[0]
      await deletePhotoRow(oldest.id)
      await db.storage.from('profile-photos').remove([`${req.userId}/${oldest.id}`])
      nextPosition = oldest.position
    }

    const path = `${req.userId}/${photoId}`

    const { error: uploadErr } = await db.storage
      .from('profile-photos')
      .upload(path, photo.buffer, { contentType: photo.mime, upsert: true, cacheControl: '604800' })

    if (uploadErr) return reply.status(500).send({ error: 'upload_failed' })

    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    try {
      await sql`
        insert into user_photos (id, user_id, url, position)
        values (${photoId}, ${req.userId}, ${publicUrl}, ${nextPosition})`
    } catch {
      return reply.status(500).send({ error: 'photo_confirm_failed' })
    }

    // A fresh photo lifts a photo-review pause (same as /confirm).
    await liftPhotoReviewPause(req.userId)

    await maybeQualifyReferral(req.userId)
    if (nextPosition === 0) scheduleMainPhotoCheck(req.userId, req.log)

    return { photo: { id: photoId, url: publicUrl, position: nextPosition } }
  })
}
