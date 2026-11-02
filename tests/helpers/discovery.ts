import { createUser, createPhoto, insertRow } from './db.js'

/** A complete discoverable profile (active, one photo). Defaults: a woman seeking men. */
export async function createProfile(overrides: Record<string, unknown> = {}, photos = 1) {
  const user = await createUser({ gender: 'woman', looking_for: 'men', ...overrides })
  for (let i = 0; i < photos; i++) await createPhoto(user.id, i)
  return user
}

export async function like(swiper: { id: string }, swiped: { id: string }, overrides: Record<string, unknown> = {}) {
  return insertRow('swipes', { swiper_id: swiper.id, swiped_id: swiped.id, direction: 'like', ...overrides })
}

export async function pass(swiper: { id: string }, swiped: { id: string }, overrides: Record<string, unknown> = {}) {
  return insertRow('swipes', { swiper_id: swiper.id, swiped_id: swiped.id, direction: 'pass', ...overrides })
}

export async function block(blocker: { id: string }, blocked: { id: string }) {
  return insertRow('blocks', { blocker_id: blocker.id, blocked_id: blocked.id })
}

/** ISO timestamp `minutes` ago. */
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
