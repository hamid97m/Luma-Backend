import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { randomUUID } from 'crypto'
import { fetchTelegramProfilePhoto } from '../bot.js'

const MAX_PHOTOS = 6

export async function photosRoutes(app: FastifyInstance) {
  // Get a signed upload URL
  app.post('/profile/me/photos/upload-url', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { contentType, replacePhotoId } = req.body as { contentType: string; replacePhotoId?: string }

    const { data: existing } = await db
      .from('user_photos')
      .select('id')
      .eq('user_id', req.userId)

    // A replace keeps the net photo count unchanged (the old photo is removed as
    // the new one lands), so the cap must not block it — even at MAX_PHOTOS.
    const isReplace = !!replacePhotoId && (existing?.some((p) => p.id === replacePhotoId) ?? false)

    if (!req.isPaused && !isReplace && (existing?.length ?? 0) >= MAX_PHOTOS) {
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

    const { data: photo, error } = await db
      .from('user_photos')
      .select('id, position')
      .eq('id', photoId)
      .eq('user_id', req.userId)
      .single()

    if (error || !photo) return reply.status(404).send({ error: 'photo_not_found' })

    // Don't allow deleting the last remaining photo — a profile must keep at least one.
    const { count } = await db
      .from('user_photos')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.userId)

    if ((count ?? 0) <= 1) return reply.status(409).send({ error: 'last_photo' })

    await db.from('user_photos').delete().eq('id', photoId)
    await db.storage.from('profile-photos').remove([`${req.userId}/${photoId}`])

    const { data: remaining } = await db
      .from('user_photos')
      .select('id, position')
      .eq('user_id', req.userId)
      .gt('position', photo.position)

    for (const p of remaining ?? []) {
      await db.from('user_photos').update({ position: p.position - 1 }).eq('id', p.id)
    }

    return { ok: true }
  })

  // Reorder photos
  app.patch('/profile/me/photos/reorder', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { order } = req.body as { order: string[] }

    // UNIQUE(user_id, position) means writing final positions directly can collide
    // with whatever photo currently holds that slot, so stage through negative
    // positions first to clear all slots before assigning the real ones.
    for (let i = 0; i < order.length; i++) {
      const { error } = await db
        .from('user_photos')
        .update({ position: -(i + 1) })
        .eq('id', order[i])
        .eq('user_id', req.userId)

      if (error) return reply.status(500).send({ error: 'reorder_failed' })
    }

    for (let i = 0; i < order.length; i++) {
      const { error } = await db
        .from('user_photos')
        .update({ position: i })
        .eq('id', order[i])
        .eq('user_id', req.userId)

      if (error) return reply.status(500).send({ error: 'reorder_failed' })
    }

    return { ok: true }
  })

  // Confirm a photo upload (insert DB row after client uploads to storage)
  app.post('/profile/me/photos/confirm', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { photoId } = req.body as { photoId: string }

    if (!photoId || typeof photoId !== 'string') {
      return reply.status(400).send({ error: 'invalid_photo_id' })
    }

    const { data: existing } = await db
      .from('user_photos')
      .select('id, position')
      .eq('user_id', req.userId)
      .order('position', { ascending: true })

    const count = existing?.length ?? 0
    if (count >= MAX_PHOTOS && !req.isPaused) {
      return reply.status(400).send({ error: 'max_photos_reached' })
    }

    const alreadyExists = existing?.some((p) => p.id === photoId)
    if (alreadyExists) {
      return reply.status(409).send({ error: 'photo_already_confirmed' })
    }

    // A paused user re-verifying at the photo cap: evict their oldest photo
    // (lowest position) so the fresh photo can land — and lift the pause —
    // instead of hitting max_photos_reached. Reuse the freed slot's position.
    let nextPosition = count
    if (count >= MAX_PHOTOS && req.isPaused && existing && existing.length > 0) {
      const oldest = existing[0]
      await db.from('user_photos').delete().eq('id', oldest.id)
      await db.storage.from('profile-photos').remove([`${req.userId}/${oldest.id}`])
      nextPosition = oldest.position
    }

    const path = `${req.userId}/${photoId}`
    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    const { error: insertErr } = await db.from('user_photos').insert({
      id: photoId,
      user_id: req.userId,
      url: publicUrl,
      position: nextPosition,
    })

    if (insertErr) return reply.status(500).send({ error: 'photo_confirm_failed' })

    // A fresh photo lifts a photo-review pause. The .not() guard makes this a
    // no-op for the common (non-paused) upload; when it does match, resolve the
    // pending reports that triggered the pause so the count resets and the user
    // is not immediately re-paused.
    const { data: resumed } = await db
      .from('users')
      .update({ paused_at: null })
      .eq('id', req.userId)
      .not('paused_at', 'is', null)
      .select('id')
      .maybeSingle()
    if (resumed) {
      await db
        .from('reports')
        .update({ status: 'resolved_reuploaded', resolved_at: new Date().toISOString() })
        .eq('reported_id', req.userId)
        .eq('status', 'pending')
    }

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

    const { data: oldPhoto, error } = await db
      .from('user_photos')
      .select('id, position')
      .eq('id', photoId)
      .eq('user_id', req.userId)
      .single()

    if (error || !oldPhoto) return reply.status(404).send({ error: 'photo_not_found' })

    // Remove the old row + storage object, then insert the fresh one at the freed
    // position (mirrors the paused-eviction path in /confirm).
    await db.from('user_photos').delete().eq('id', photoId)
    await db.storage.from('profile-photos').remove([`${req.userId}/${photoId}`])

    const path = `${req.userId}/${newPhotoId}`
    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    const { error: insertErr } = await db.from('user_photos').insert({
      id: newPhotoId,
      user_id: req.userId,
      url: publicUrl,
      position: oldPhoto.position,
    })

    if (insertErr) return reply.status(500).send({ error: 'photo_replace_failed' })

    // A fresh photo lifts a photo-review pause (same as /confirm).
    const { data: resumed } = await db
      .from('users')
      .update({ paused_at: null })
      .eq('id', req.userId)
      .not('paused_at', 'is', null)
      .select('id')
      .maybeSingle()
    if (resumed) {
      await db
        .from('reports')
        .update({ status: 'resolved_reuploaded', resolved_at: new Date().toISOString() })
        .eq('reported_id', req.userId)
        .eq('status', 'pending')
    }

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

    const { data: u } = await db
      .from('users')
      .select('telegram_id')
      .eq('id', req.userId)
      .single()

    if (!u || !u.telegram_id || u.telegram_id <= 0) {
      return reply.status(409).send({ error: 'no_telegram_photo' })
    }

    const { data: existing } = await db
      .from('user_photos')
      .select('id, position')
      .eq('user_id', req.userId)
      .order('position', { ascending: true })

    const count = existing?.length ?? 0
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
    if (count >= MAX_PHOTOS && req.isPaused && existing && existing.length > 0) {
      const oldest = existing[0]
      await db.from('user_photos').delete().eq('id', oldest.id)
      await db.storage.from('profile-photos').remove([`${req.userId}/${oldest.id}`])
      nextPosition = oldest.position
    }

    const path = `${req.userId}/${photoId}`

    const { error: uploadErr } = await db.storage
      .from('profile-photos')
      .upload(path, photo.buffer, { contentType: photo.mime, upsert: true })

    // Temporary: surface the real Supabase storage error so a field failure is
    // diagnosable instead of an opaque upload_failed.
    if (uploadErr) return reply.status(500).send({ error: 'upload_failed', detail: uploadErr.message, mime: photo.mime })

    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    const { error: insertErr } = await db.from('user_photos').insert({
      id: photoId,
      user_id: req.userId,
      url: publicUrl,
      position: nextPosition,
    })

    if (insertErr) return reply.status(500).send({ error: 'photo_confirm_failed' })

    // A fresh photo lifts a photo-review pause (same as /confirm).
    const { data: resumed } = await db
      .from('users')
      .update({ paused_at: null })
      .eq('id', req.userId)
      .not('paused_at', 'is', null)
      .select('id')
      .maybeSingle()
    if (resumed) {
      await db
        .from('reports')
        .update({ status: 'resolved_reuploaded', resolved_at: new Date().toISOString() })
        .eq('reported_id', req.userId)
        .eq('status', 'pending')
    }

    return { photo: { id: photoId, url: publicUrl, position: nextPosition } }
  })
}
