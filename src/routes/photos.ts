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

    const publicUrl = db.storage.from('profile-photos').getPublicUrl(path).data.publicUrl
    const nextPosition = existing?.length ?? 0

    // Pre-register the photo row; the upload-url path is the key
    const { error: insertErr } = await db.from('user_photos').insert({
      id: photoId,
      user_id: req.userId,
      url: publicUrl,
      position: nextPosition,
    })
    if (insertErr) return reply.status(500).send({ error: 'photo_register_failed' })

    return {
      uploadUrl: signedData.signedUrl,
      publicUrl,
      photoId,
    }
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

    // Compact positions: shift photos above deleted photo down by 1
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

    for (let i = 0; i < order.length; i++) {
      await db
        .from('user_photos')
        .update({ position: i })
        .eq('id', order[i])
        .eq('user_id', req.userId)
    }

    return { ok: true }
  })
}
