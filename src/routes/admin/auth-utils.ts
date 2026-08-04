import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const TOKEN_TTL = '12h'

export interface AdminTokenPayload {
  adminId: string
  username: string
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, process.env.ADMIN_JWT_SECRET!, { expiresIn: TOKEN_TTL })
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET!)
    if (typeof decoded !== 'object' || decoded === null) return null
    const { adminId, username } = decoded as jwt.JwtPayload & AdminTokenPayload
    if (!adminId || !username) return null
    return { adminId, username }
  } catch {
    return null
  }
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
