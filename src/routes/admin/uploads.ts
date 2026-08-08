import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { randomUUID } from 'crypto'

const BUCKET = 'profile-photos'

export async function adminUploadsRoutes(app: FastifyInstance) {
  // Return a signed upload URL + the eventual public URL for a fresh object.
  // No DB row is written — the public URL flows into a fake user's photos array,
  // which the users route persists into user_photos.
  app.post('/uploads/image-url', async (req, reply) => {
    const { contentType } = (req.body ?? {}) as { contentType?: string }
    void contentType // reserved for future validation; objects are stored as .jpg

    const path = `seed/${randomUUID()}.jpg`

    const { data: signed, error } = await db.storage
      .from(BUCKET)
      .createSignedUploadUrl(path)

    if (error || !signed) {
      return reply.status(500).send({ error: 'upload_url_failed' })
    }

    const publicUrl = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    return { uploadUrl: signed.signedUrl, publicUrl }
  })
}
