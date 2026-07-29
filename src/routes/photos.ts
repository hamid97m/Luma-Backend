import { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { randomUUID } from 'crypto'

const MAX_PHOTOS = 6

export async function photosRoutes(app: FastifyInstance) {
  // Get a signed upload URL
  app.post('/profile/me/photos/upload-url', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { contentType } = req.body as { contentType: string }

    const { data: existing } = await db
      .from('user_photos')
      .select('id')
      .eq('user_id', req.userId)

    if ((existing?.length ?? 0) >= MAX_PHOTOS) {
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
      .select('id')
      .eq('user_id', req.userId)

    if ((existing?.length ?? 0) >= MAX_PHOTOS) {
      return reply.status(400).send({ error: 'max_photos_reached' })
    }

    const alreadyExists = existing?.some((p) => p.id === photoId)
    if (alreadyExists) {
      return reply.status(409).send({ error: 'photo_already_confirmed' })
    }

    const nextPosition = existing?.length ?? 0
    const path = `${req.userId}/${photoId}`
    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl

    const { error: insertErr } = await db.from('user_photos').insert({
      id: photoId,
      user_id: req.userId,
      url: publicUrl,
      position: nextPosition,
    })

    if (insertErr) return reply.status(500).send({ error: 'photo_confirm_failed' })

    return { photo: { id: photoId, url: publicUrl, position: nextPosition } }
  })
}
