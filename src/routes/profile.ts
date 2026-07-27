import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

async function getProfileWithPhotos(userId: string) {
  const { data: user, error } = await db
    .from('users')
    .select('id, name, age, gender, looking_for, bio')
    .eq('id', userId)
    .single()
  if (error || !user) return null

  const { data: photos } = await db
    .from('user_photos')
    .select('id, url, position')
    .eq('user_id', userId)
    .order('position', { ascending: true })

  const setupComplete = user.age > 0 && (photos?.length ?? 0) > 0

  return { ...user, photos: photos ?? [], setupComplete }
}

export async function profileRoutes(app: FastifyInstance) {
  app.get('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(404).send({ error: 'user_not_found' })
    const profile = await getProfileWithPhotos(req.userId)
    if (!profile) return reply.status(404).send({ error: 'user_not_found' })
    return profile
  })

  app.put('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(404).send({ error: 'user_not_found' })

    const allowed = ['name', 'age', 'gender', 'looking_for', 'bio'] as const
    const body = req.body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }

    const { data: user, error } = await db
      .from('users')
      .update({ ...updates, last_active: new Date().toISOString() })
      .eq('id', req.userId)
      .select('id, name, age, gender, looking_for, bio')
      .single()

    if (error || !user) return reply.status(500).send({ error: 'update_failed' })

    const { data: photos } = await db
      .from('user_photos')
      .select('id, url, position')
      .eq('user_id', req.userId)
      .order('position', { ascending: true })

    return {
      ...user,
      photos: photos ?? [],
      setupComplete: user.age > 0 && (photos?.length ?? 0) > 0,
    }
  })
}
