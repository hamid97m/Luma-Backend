import { FastifyInstance } from 'fastify'
import { db } from '../db.js'

export async function getProfileWithPhotos(userId: string) {
  const { data: user, error } = await db
    .from('users')
    .select('id, name, age, gender, looking_for, bio, interests, location, icebreaker_prompt, icebreaker_answer, is_active')
    .eq('id', userId)
    .single()
  if (error || !user) return null

  const { data: photos } = await db
    .from('user_photos')
    .select('id, url, position')
    .eq('user_id', userId)
    .order('position', { ascending: true })

  const setupComplete = user.age > 0

  return { ...user, photos: photos ?? [], setupComplete }
}

export async function profileRoutes(app: FastifyInstance) {
  app.get('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const profile = await getProfileWithPhotos(req.userId)
    if (!profile) return reply.status(404).send({ error: 'user_not_found' })
    return profile
  })

  app.put('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const allowed = ['name', 'age', 'gender', 'looking_for', 'bio', 'interests', 'location', 'icebreaker_prompt', 'icebreaker_answer', 'is_active'] as const
    const body = req.body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'no_fields' })
    }

    const { data: user, error } = await db
      .from('users')
      .update({ ...updates, last_active: new Date().toISOString() })
      .eq('id', req.userId)
      .select('id, name, age, gender, looking_for, bio, interests, location, icebreaker_prompt, icebreaker_answer, is_active')
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
      setupComplete: user.age > 0,
    }
  })

  // Recorded when the user answers the in-app requestWriteAccess() popup —
  // initData only refreshes on the next launch, so without this a mid-session
  // grant would stay invisible until the app is reopened.
  app.post('/profile/me/write-access', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { granted } = req.body as { granted?: boolean }
    if (typeof granted !== 'boolean') return reply.status(400).send({ error: 'invalid_granted' })

    const { error } = await db.from('users').update({ allows_write_to_pm: granted }).eq('id', req.userId)
    if (error) return reply.status(500).send({ error: 'update_failed' })
    return { ok: true }
  })

  app.delete('/profile/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })

    const { data: photos } = await db
      .from('user_photos')
      .select('id')
      .eq('user_id', req.userId)

    if (photos?.length) {
      const { error: storageError } = await db.storage.from('profile-photos').remove(photos.map((p) => `${req.userId}/${p.id}`))
      if (storageError) {
        console.error(`Failed to remove profile photos for user ${req.userId}:`, storageError)
      }
      const { error: deleteError } = await db.from('user_photos').delete().eq('user_id', req.userId)
      if (deleteError) return reply.status(500).send({ error: 'delete_failed' })
    }

    const { error } = await db.from('users').update({
      name: '',
      bio: null,
      interests: [],
      location: null,
      icebreaker_prompt: null,
      icebreaker_answer: null,
      age: 0,
      is_active: false,
      deleted_at: new Date().toISOString(),
    }).eq('id', req.userId)

    if (error) return reply.status(500).send({ error: 'delete_failed' })
    return { ok: true }
  })
}
