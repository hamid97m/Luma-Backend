import jwt from 'jsonwebtoken'

// Session tokens for the website (outside Telegram, there is no initData).
const TOKEN_TTL = '30d'
const MIN_SECRET_LENGTH = 32

/** Website sign-in needs a real signing secret; without one it is switched
 *  off (the Mini App's initData auth doesn't use it and keeps working). */
export function isSessionSecretConfigured(): boolean {
  return (process.env.USER_JWT_SECRET ?? '').length >= MIN_SECRET_LENGTH
}

export function signSessionToken(userId: string): string {
  return jwt.sign({ userId }, process.env.USER_JWT_SECRET!, { expiresIn: TOKEN_TTL })
}

/** The user id inside a valid, unexpired token; null otherwise. */
export function verifySessionToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, process.env.USER_JWT_SECRET!, { algorithms: ['HS256'] })
    if (typeof decoded !== 'object' || decoded === null) return null
    const { userId } = decoded as jwt.JwtPayload & { userId?: unknown }
    return typeof userId === 'string' && userId ? userId : null
  } catch {
    return null
  }
}
