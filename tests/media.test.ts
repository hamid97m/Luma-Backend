import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { buildApp } from '../src/server.js'
import * as storage from '../src/storage.js'

const MEDIA_DIR = () => process.env.MEDIA_DIR!
const publicFile = (path: string) => join(MEDIA_DIR(), 'public', 'profile-photos', ...path.split('/'))
const privateFile = (path: string) => join(MEDIA_DIR(), 'private', 'photo-ai-evidence', ...path.split('/'))
/** Request path of a signed URL (drop the http://api.test origin). */
const local = (url: string) => {
  expect(url.startsWith('http://api.test/')).toBe(true)
  return url.slice('http://api.test'.length)
}
const tokenOf = (url: string) => url.split('/').pop()!
const objectPath = () => `${randomUUID()}/${randomUUID()}`

describe('storage module', () => {
  it('isSafeObjectPath accepts normal object paths', () => {
    expect(storage.isSafeObjectPath(`${randomUUID()}/${randomUUID()}`)).toBe(true)
    expect(storage.isSafeObjectPath('seed/abc-123.jpg')).toBe(true)
  })

  it('isSafeObjectPath rejects traversal, absolute paths, empty segments and backslashes', () => {
    for (const bad of [
      '..', '../x', 'a/../b', 'a/..', '.', './a',
      '/etc/passwd', '/a',
      '', 'a//b', 'a/', '/',
      'a\\b', '..\\..\\x',
      'a/b/c/d/e', // deeper than any bucket path
      'a b', 'a/%2e%2e',
    ]) {
      expect(storage.isSafeObjectPath(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('upload then download round-trips the bytes (public and private buckets)', async () => {
    const p = objectPath()
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])
    await storage.upload('profile-photos', p, bytes)
    expect(await storage.download('profile-photos', p)).toEqual(bytes)
    expect(await readFile(publicFile(p))).toEqual(bytes)

    await storage.upload('photo-ai-evidence', p, bytes)
    expect(await readFile(privateFile(p))).toEqual(bytes)
  })

  it('upload overwrites an existing object', async () => {
    const p = objectPath()
    await storage.upload('profile-photos', p, Buffer.from('one'))
    await storage.upload('profile-photos', p, Buffer.from('two'))
    expect((await storage.download('profile-photos', p))!.toString()).toBe('two')
  })

  it('download of a missing object is null', async () => {
    expect(await storage.download('profile-photos', objectPath())).toBeNull()
  })

  it('remove deletes objects and tolerates missing ones', async () => {
    const p = objectPath()
    await storage.upload('profile-photos', p, Buffer.from('x'))
    await expect(storage.remove('profile-photos', [p, objectPath()])).resolves.toBeUndefined()
    expect(existsSync(publicFile(p))).toBe(false)
    await expect(storage.remove('profile-photos', [p])).resolves.toBeUndefined()
  })

  it('refuses unsafe paths instead of touching the filesystem', async () => {
    await expect(storage.upload('profile-photos', '../escape', Buffer.from('x'))).rejects.toThrow('unsafe object path')
    await expect(storage.download('profile-photos', '../escape')).rejects.toThrow('unsafe object path')
    expect(() => storage.createSignedUploadUrl('profile-photos', '/abs')).toThrow('unsafe object path')
    expect(() => storage.createSignedUrl('photo-ai-evidence', 'a//b', 60)).toThrow('unsafe object path')
  })

  it('builds public / upload / private URLs on the API origin', () => {
    expect(storage.getPublicUrl('profile-photos', 'u/p')).toBe('http://api.test/media/profile-photos/u/p')
    expect(storage.createSignedUploadUrl('profile-photos', 'u/p')).toMatch(/^http:\/\/api\.test\/media-upload\/[\w-]+\.[\w-]+$/)
    expect(storage.createSignedUrl('photo-ai-evidence', 'u/p', 60)).toMatch(/^http:\/\/api\.test\/media-private\/[\w-]+\.[\w-]+$/)
  })

  it('upload tokens live 2h and are bound to their operation', () => {
    const now = Date.now()
    const t = tokenOf(storage.createSignedUploadUrl('profile-photos', 'u/p', now))
    expect(storage.verifyToken(t, 'put', now + 2 * 3600_000 - 1000)).toMatchObject({ op: 'put', b: 'profile-photos', p: 'u/p' })
    expect(storage.verifyToken(t, 'put', now + 2 * 3600_000 + 1000)).toBeNull()
    expect(storage.verifyToken(t, 'get', now)).toBeNull()
  })
})

describe('media routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    app = await buildApp()
  })

  const put = (url: string, payload: Buffer | string, headers: Record<string, string> = { 'content-type': 'image/jpeg' }) =>
    app.inject({ method: 'PUT', url, headers, payload })

  describe('PUT /media-upload/:token', () => {
    it('writes the exact bytes to the object file without an Authorization header', async () => {
      const p = objectPath()
      const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))

      const res = await put(local(storage.createSignedUploadUrl('profile-photos', p)), bytes)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
      expect(await readFile(publicFile(p))).toEqual(bytes)
    })

    it('accepts uploads above Fastify\'s default 1 MB body limit', async () => {
      const p = objectPath()
      const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
      const res = await put(local(storage.createSignedUploadUrl('profile-photos', p)), bytes)
      expect(res.statusCode).toBe(200)
      expect((await readFile(publicFile(p))).length).toBe(bytes.length)
    })

    it('accepts application/octet-stream and other image/* types', async () => {
      for (const type of ['application/octet-stream', 'image/png', 'image/webp']) {
        const p = objectPath()
        const res = await put(local(storage.createSignedUploadUrl('profile-photos', p)), Buffer.from(type), { 'content-type': type })
        expect(res.statusCode, type).toBe(200)
        expect((await readFile(publicFile(p))).toString()).toBe(type)
      }
    })

    it('writes private-bucket uploads under private/', async () => {
      const p = objectPath()
      const res = await put(local(storage.createSignedUploadUrl('photo-ai-evidence', p)), Buffer.from('ev'))
      expect(res.statusCode).toBe(200)
      expect((await readFile(privateFile(p))).toString()).toBe('ev')
      expect(existsSync(publicFile(p))).toBe(false)
    })

    it('rejects a tampered token with 403', async () => {
      const p = objectPath()
      const url = local(storage.createSignedUploadUrl('profile-photos', p))
      const [body, mac] = tokenOf(url).split('.')
      const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

      // Bad MAC, and a body re-pointed at another path with the original MAC.
      const otherBody = Buffer.from(JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: 'victim/photo',
      })).toString('base64url')
      for (const token of [`${body}.${flip(mac)}`, `${otherBody}.${mac}`, body, 'garbage', `${body}.`]) {
        const res = await put(`/media-upload/${token}`, Buffer.from('x'))
        expect(res.statusCode, token).toBe(403)
        expect(res.json()).toEqual({ error: 'invalid_upload_token' })
      }
      expect(existsSync(publicFile(p))).toBe(false)
      expect(existsSync(publicFile('victim/photo'))).toBe(false)
    })

    it('rejects an expired token with 403', async () => {
      const p = objectPath()
      const url = storage.createSignedUploadUrl('profile-photos', p, Date.now() - 3 * 3600_000)
      const res = await put(local(url), Buffer.from('x'))
      expect(res.statusCode).toBe(403)
      expect(existsSync(publicFile(p))).toBe(false)
    })

    it('rejects a read (GET) token used for an upload with 403', async () => {
      const p = objectPath()
      const token = tokenOf(storage.createSignedUrl('profile-photos', p, 3600))
      const res = await put(`/media-upload/${token}`, Buffer.from('x'))
      expect(res.statusCode).toBe(403)
      expect(existsSync(publicFile(p))).toBe(false)
    })

    it('rejects an empty body with 400', async () => {
      const p = objectPath()
      const res = await put(local(storage.createSignedUploadUrl('profile-photos', p)), Buffer.alloc(0))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'empty_upload' })
      expect(existsSync(publicFile(p))).toBe(false)
    })

    it('rejects a body over 15 MB with 413', async () => {
      const p = objectPath()
      const res = await put(local(storage.createSignedUploadUrl('profile-photos', p)), Buffer.alloc(15 * 1024 * 1024 + 1))
      expect(res.statusCode).toBe(413)
      expect(existsSync(publicFile(p))).toBe(false)
    })

    it('returns 500 upload_failed when the file cannot be written', async () => {
      const { chmod, mkdir } = await import('node:fs/promises')
      const [user, photo] = objectPath().split('/')
      const dir = join(MEDIA_DIR(), 'public', 'profile-photos', user)
      await mkdir(dir, { recursive: true })
      await chmod(dir, 0o500)
      try {
        const res = await put(local(storage.createSignedUploadUrl('profile-photos', `${user}/${photo}`)), Buffer.from('x'))
        expect(res.statusCode).toBe(500)
        expect(res.json()).toEqual({ error: 'upload_failed' })
      } finally {
        await chmod(dir, 0o700)
      }
    })
  })

  describe('GET /media-private/:token', () => {
    it('serves the file for a valid read token, without auth', async () => {
      const p = objectPath()
      const bytes = Buffer.from('private-evidence')
      await storage.upload('photo-ai-evidence', p, bytes)

      const res = await app.inject({ method: 'GET', url: local(storage.createSignedUrl('photo-ai-evidence', p, 60)) })

      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(bytes)
      expect(res.headers['content-type']).toBe('image/jpeg')
      expect(res.headers['cache-control']).toBe('private, max-age=300')
    })

    it('403s for a tampered token, an expired token, or an upload token', async () => {
      const p = objectPath()
      await storage.upload('photo-ai-evidence', p, Buffer.from('x'))
      const good = tokenOf(storage.createSignedUrl('photo-ai-evidence', p, 60))
      const [body, mac] = good.split('.')
      const tampered = `${body}.${(mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)}`
      const expired = tokenOf(storage.createSignedUrl('photo-ai-evidence', p, 60, Date.now() - 120_000))
      const uploadToken = tokenOf(storage.createSignedUploadUrl('photo-ai-evidence', p))

      for (const token of [tampered, expired, uploadToken]) {
        const res = await app.inject({ method: 'GET', url: `/media-private/${token}` })
        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual({ error: 'invalid_media_token' })
      }
    })

    it('404s when the object does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: local(storage.createSignedUrl('photo-ai-evidence', objectPath(), 60)) })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'not_found' })
    })
  })

  describe('GET /media/:bucket/*', () => {
    it('serves a public profile photo', async () => {
      const p = objectPath()
      await storage.upload('profile-photos', p, Buffer.from('public-photo'))

      const res = await app.inject({ method: 'GET', url: local(storage.getPublicUrl('profile-photos', p)) })

      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.toString()).toBe('public-photo')
      expect(res.headers['cache-control']).toBe('public, max-age=604800, immutable')
    })

    it('404s for a missing public file', async () => {
      const res = await app.inject({ method: 'GET', url: `/media/profile-photos/${objectPath()}` })
      expect(res.statusCode).toBe(404)
    })

    it('never serves the private bucket publicly', async () => {
      const p = objectPath()
      await storage.upload('photo-ai-evidence', p, Buffer.from('secret'))
      const res = await app.inject({ method: 'GET', url: `/media/photo-ai-evidence/${p}` })
      expect(res.statusCode).toBe(404)
      expect(res.body).not.toContain('secret')
    })

    it('404s for unknown buckets and traversal attempts', async () => {
      const p = objectPath()
      await storage.upload('photo-ai-evidence', p, Buffer.from('secret'))
      for (const url of [
        `/media/nope/${p}`,
        `/media/profile-photos/..%2F..%2Fprivate%2Fphoto-ai-evidence%2F${p.replace('/', '%2F')}`,
        `/media/profile-photos/x/..%2F..%2F..%2Fprivate/photo-ai-evidence/${p}`,
      ]) {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, url).toBe(404)
        expect(res.body).not.toContain('secret')
      }
    })
  })
})

describe('CORS preflight for signed uploads', () => {
  afterEach(() => vi.unstubAllEnvs())

  const preflight = (app: Awaited<ReturnType<typeof buildApp>>, origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: `/media-upload/${tokenOf(storage.createSignedUploadUrl('profile-photos', objectPath()))}`,
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,cache-control',
      },
    })

  it('allows the Mini App origin to PUT with content-type + cache-control headers', async () => {
    vi.stubEnv('WEB_URL', 'https://app.luma.test')
    vi.stubEnv('ADMIN_WEB_URL', 'https://admin.luma.test')
    const app = await buildApp()

    for (const origin of ['https://app.luma.test', 'https://admin.luma.test']) {
      const res = await preflight(app, origin)
      expect(res.statusCode, origin).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe(origin)
      expect(String(res.headers['access-control-allow-methods'])).toContain('PUT')
      expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('content-type')
      expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('cache-control')
    }
  })

  it('does not grant a foreign origin when an origin list is configured', async () => {
    vi.stubEnv('WEB_URL', 'https://app.luma.test')
    const app = await buildApp()
    const res = await preflight(app, 'https://evil.test')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('falls back to a wildcard origin when WEB_URL / ADMIN_WEB_URL are unset', async () => {
    vi.stubEnv('WEB_URL', '')
    vi.stubEnv('ADMIN_WEB_URL', '')
    const app = await buildApp()
    const res = await preflight(app, 'https://anything.test')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('cache-control')
  })
})
