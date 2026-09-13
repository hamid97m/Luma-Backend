import { randomBytes } from 'node:crypto'
import { db } from '../db.js'

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
    const { data: user, error } = await db
      .from('users').select('referral_code').eq('id', userId).single()
    if (error) return null
    if (user.referral_code) return user.referral_code
    // Retry on unique collision (astronomically rare with 31^8 codes).
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateReferralCode()
      const { error: updateError } = await db
        .from('users').update({ referral_code: code }).eq('id', userId)
      if (!updateError) return code
    }
    return null
  } catch {
    return null
  }
}

export async function stashReferralClaim(telegramId: number, code: string): Promise<void> {
  try {
    await db.from('referral_claims').upsert(
      { telegram_id: telegramId, code, created_at: new Date().toISOString() },
      { onConflict: 'telegram_id' }
    )
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
      const { data: claim } = await db
        .from('referral_claims').select('code').eq('telegram_id', telegramId).maybeSingle()
      code = claim?.code ?? null
      fromClaim = code !== null
    }
    if (!code) return
    const { data: referrer } = await db
      .from('users').select('id').eq('referral_code', code).maybeSingle()
    if (!referrer || referrer.id === newUserId) return
    await db.from('users').update({ referred_by: referrer.id }).eq('id', newUserId)
    await db.from('referrals').insert({ referrer_id: referrer.id, referred_id: newUserId })
    if (fromClaim) await db.from('referral_claims').delete().eq('telegram_id', telegramId)
  } catch {
    // attribution must never break signup
  }
}
