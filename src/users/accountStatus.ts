import { sql } from '../db.js'

/** A signup is finished only when the profile has an age, a city, and a photo. */
export function isSignupComplete(
  user: { age?: number | null; location?: string | null },
  photoCount: number,
): boolean {
  const city = typeof user.location === 'string' ? user.location.trim() : ''
  const age = user.age
  return typeof age === 'number'
    && Number.isInteger(age)
    && age >= 18
    && age <= 99
    && city.length >= 2
    && photoCount >= 1
}

/**
 * Promote a preparing account once signup is complete. No-op for an account
 * that is already active, or that is still missing age, city, or a photo.
 * A failed write is logged and swallowed so profile reads still succeed.
 */
export async function markActiveIfSignupComplete(
  userId: string,
  user: { age?: number | null; location?: string | null; account_status?: string | null },
  photoCount: number,
): Promise<void> {
  if (user.account_status === 'active') return
  if (!isSignupComplete(user, photoCount)) return
  try {
    await sql`
      update users set account_status = 'active'
      where id = ${userId} and account_status = 'preparing'`
  } catch (error) {
    console.error('markActiveIfSignupComplete failed', error)
  }
}
