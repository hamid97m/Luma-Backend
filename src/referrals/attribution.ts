import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 8

export function generateReferralCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

export function parseRefCode(payload: string | null | undefined): string | null {
  if (!payload || !payload.startsWith('ref_')) return null
  const code = payload.slice(4)
  if (!/^[a-z0-9]{1,32}$/.test(code)) return null
  return code
}

export async function ensureReferralCode(userId: string): Promise<string | null> {
  try {
    const [user] = await sql<{ referral_code: string | null }[]>`
      select referral_code from users where id = ${userId}`
    if (!user) return null
    if (user.referral_code) return user.referral_code
    // Retry on unique collision (astronomically rare with 31^8 codes).
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateReferralCode()
      try {
        await sql`update users set referral_code = ${code} where id = ${userId}`
        return code
      } catch {
        // 23505 on users_referral_code_key (or any write error): try another code
      }
    }
    return null
  } catch {
    return null
  }
}

export async function stashReferralClaim(telegramId: number, code: string): Promise<void> {
  try {
    await sql`
      insert into referral_claims (telegram_id, code, created_at)
      values (${telegramId}, ${code}, ${new Date().toISOString()})
      on conflict (telegram_id) do update set code = excluded.code, created_at = excluded.created_at`
  } catch {
    // best-effort; a lost claim only loses attribution, never breaks /start
  }
}

export async function captureReferralAttribution(
  newUserId: string,
  telegramId: number,
  startParam: string | null
): Promise<void> {
  try {
    let code = parseRefCode(startParam)
    let fromClaim = false
    if (!code) {
      const [claim] = await sql<{ code: string }[]>`
        select code from referral_claims where telegram_id = ${telegramId}`
      code = claim?.code ?? null
      fromClaim = code !== null
    }
    if (!code) return
    const [referrer] = await sql<{ id: string }[]>`select id from users where referral_code = ${code}`
    if (!referrer || referrer.id === newUserId) return
    // Each write was independent and its error ignored (supabase-js never threw): a failed
    // step must not skip the ones after it.
    await sql`update users set referred_by = ${referrer.id} where id = ${newUserId}`.catch(() => {})
    await sql`insert into referrals (referrer_id, referred_id) values (${referrer.id}, ${newUserId})`.catch(() => {})
    if (fromClaim) await sql`delete from referral_claims where telegram_id = ${telegramId}`.catch(() => {})
  } catch {
    // attribution must never break signup
  }
}
