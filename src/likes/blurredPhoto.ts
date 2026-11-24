import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'
import { download } from '../storage.js'
import { profilePhotoObjectPath } from './photoPath.js'

/**
 * Teaser photos of locked likers. The token is ENCRYPTED, not just signed: an
 * object path carries the liker's user id, and that id is enough to like him
 * back. The image is shrunk + blurred here, so the original never leaves.
 */

const PREFIX = '/likes/blurred/'
const MAX_CACHE = 500
const cache = new Map<string, Buffer>()

function key(purpose: string): Buffer {
  const secret = process.env.USER_JWT_SECRET || process.env.BOT_TOKEN || ''
  return createHash('sha256').update(`${secret}:likes-blur:${purpose}`).digest()
}

function apiBase(): string {
  return (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '')
}

export function encodeBlurToken(path: string, exp: number): string {
  const plain = JSON.stringify([exp, path])
  // Synthetic IV (keyed hash of the content): the same photo keeps one URL within the hour, so it caches.
  const iv = createHmac('sha256', key('iv')).update(plain).digest().subarray(0, 12)
  const c = createCipheriv('aes-256-gcm', key('enc'), iv)
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64url')
}

/** Object path, or null when the token is forged or expired. */
export function decodeBlurToken(token: string, nowMs = Date.now()): string | null {
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', key('enc'), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(raw.length - 16))
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8')
    const [exp, path] = JSON.parse(plain) as [number, string]
    return exp * 1000 > nowMs ? path : null
  } catch {
    return null
  }
}

/** Null when the photo isn't on our disk (the client draws a plain tile). */
export function blurredPhotoUrl(photoUrl: string, nowMs = Date.now()): string | null {
  const path = profilePhotoObjectPath(photoUrl)
  if (!path) return null
  // Snapped to the hour like the ask photo URLs: lives 2-3h, stable for one.
  const exp = (Math.floor(nowMs / 3_600_000) + 3) * 3600
  return `${apiBase()}${PREFIX}${encodeBlurToken(path, exp)}`
}

/** Tiny blurred JPEG, or null (missing file, unreadable image, no sharp). */
export async function renderBlurred(path: string): Promise<Buffer | null> {
  const hit = cache.get(path)
  if (hit) return hit
  try {
    const file = await download('profile-photos', path)
    if (!file) return null
    // Loaded on use: a server where the native module can't load must still boot.
    const { default: sharp } = await import('sharp')
    const out = await sharp(file, { failOn: 'none' })
      .rotate()
      .resize(30, 40, { fit: 'cover' })
      .blur(2.5)
      .jpeg({ quality: 70 })
      .toBuffer()
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
    cache.set(path, out)
    return out
  } catch (err) {
    console.error('[likes] blur failed:', (err as Error)?.message ?? err)
    return null
  }
}
