import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * File storage on the server's own disk.
 *
 *   MEDIA_DIR/public/<bucket>/<path>   served by nginx at MEDIA_PUBLIC_URL/<bucket>/<path>
 *   MEDIA_DIR/private/<bucket>/<path>  only via short-lived signed URLs (GET /media-private/:token)
 *
 * Clients upload with a raw PUT to a signed URL (PUT /media-upload/:token, see
 * routes/media.ts) — the same request shape the clients already use, so the
 * frontend and admin panel need no change. Object paths match the old
 * bucket paths (`<userId>/<photoId>`, `seed/<uuid>.jpg`), so migrated files keep
 * their names.
 */

export type Bucket = 'profile-photos' | 'photo-ai-evidence'

const PUBLIC_BUCKETS: ReadonlySet<Bucket> = new Set(['profile-photos'])
const BUCKETS: ReadonlySet<string> = new Set<Bucket>(['profile-photos', 'photo-ai-evidence'])

const UPLOAD_TTL_S = 2 * 60 * 60 // signed upload URLs live 2h

export function isPublicBucket(bucket: Bucket): boolean {
  return PUBLIC_BUCKETS.has(bucket)
}

function mediaDir(): string {
  return resolve(process.env.MEDIA_DIR ?? 'media')
}

/** API origin used to build upload / private-read URLs. */
function apiBaseUrl(): string {
  return (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '')
}

function mediaPublicUrl(): string {
  return (process.env.MEDIA_PUBLIC_URL ?? `${apiBaseUrl()}/media`).replace(/\/+$/, '')
}

// Each segment: letters, digits, dot, dash, underscore — and never "." / "..".
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** Object paths are generated server-side; still refuse anything that could
 *  escape the bucket directory. */
export function isSafeObjectPath(path: string): boolean {
  const parts = path.split('/')
  return parts.length > 0 && parts.length <= 4 && parts.every((p) => SEGMENT_RE.test(p) && p !== '..')
}

function filePath(bucket: Bucket, path: string): string {
  if (!BUCKETS.has(bucket)) throw new Error(`unknown bucket: ${bucket}`)
  if (!isSafeObjectPath(path)) throw new Error(`unsafe object path: ${path}`)
  return join(mediaDir(), isPublicBucket(bucket) ? 'public' : 'private', bucket, ...path.split('/'))
}

export function getPublicUrl(bucket: Bucket, path: string): string {
  return `${mediaPublicUrl()}/${bucket}/${path}`
}

/** Write atomically (temp file + rename) so readers never see a half-written image. */
export async function upload(bucket: Bucket, path: string, data: Uint8Array): Promise<void> {
  const target = filePath(bucket, path)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, target)
}

/** File contents, or null when missing. */
export async function download(bucket: Bucket, path: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath(bucket, path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Delete objects; missing files are fine (idempotent). */
export async function remove(bucket: Bucket, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await unlink(filePath(bucket, p))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }),
  )
}

// ── Signed tokens ──────────────────────────────────────────────────────────

interface TokenPayload {
  op: 'put' | 'get'
  b: Bucket
  p: string
  exp: number // unix seconds
}

// Derived from BOT_TOKEN (like the webhook secret) unless MEDIA_SIGNING_SECRET is set,
// so there's no extra env var to configure.
function signingKey(): Buffer {
  const secret = process.env.MEDIA_SIGNING_SECRET || `${process.env.BOT_TOKEN ?? ''}:media`
  return createHash('sha256').update(secret).digest()
}

function sign(body: string): string {
  return createHmac('sha256', signingKey()).update(body).digest('base64url')
}

function makeToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

/** Verified, unexpired payload for `op`, or null. */
export function verifyToken(token: string, op: TokenPayload['op'], nowMs = Date.now()): TokenPayload | null {
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (payload.op !== op || !BUCKETS.has(payload.b) || !isSafeObjectPath(payload.p)) return null
  if (!(payload.exp * 1000 > nowMs)) return null
  return payload
}

/** URL a client can PUT the raw file body to (valid 2h). */
export function createSignedUploadUrl(bucket: Bucket, path: string, nowMs = Date.now()): string {
  filePath(bucket, path) // validates bucket + path
  const token = makeToken({ op: 'put', b: bucket, p: path, exp: Math.floor(nowMs / 1000) + UPLOAD_TTL_S })
  return `${apiBaseUrl()}/media-upload/${token}`
}

/** Short-lived read URL for a (private) object. */
export function createSignedUrl(bucket: Bucket, path: string, ttlSeconds: number, nowMs = Date.now()): string {
  filePath(bucket, path)
  const token = makeToken({ op: 'get', b: bucket, p: path, exp: Math.floor(nowMs / 1000) + ttlSeconds })
  return `${apiBaseUrl()}/media-private/${token}`
}

/** Exposed for routes/media.ts. */
export { filePath as resolveObjectFile }
