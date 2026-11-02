import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Real storage, with createSignedUploadUrl wrapped so one test can make it throw.
vi.mock('../src/storage.js', async (orig) => {
  const m = await orig<typeof import('../src/storage.js')>()
  return { ...m, createSignedUploadUrl: vi.fn(m.createSignedUploadUrl) }
})

import { buildApp } from '../src/server.js'
import * as storage from '../src/storage.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'

const PUBLIC_BASE = 'http://api.test/media/profile-photos'

describe('POST /admin/uploads/image-url', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('rejects requests without a valid admin token', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/uploads/image-url', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('returns a signed upload URL and a public URL under seed/ that work end to end', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/uploads/image-url',
      headers, payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.uploadUrl).toMatch(/^http:\/\/api\.test\/media-upload\/[^/]+$/)
    const claim = storage.verifyToken(body.uploadUrl.split('/').pop(), 'put')
    expect(claim).toMatchObject({ b: 'profile-photos' })
    expect(claim!.p).toMatch(/^seed\/[0-9a-f-]+\.jpg$/)
    expect(body.publicUrl).toBe(`${PUBLIC_BASE}/${claim!.p}`)

    // Upload through the signed URL, then the public URL serves it.
    const put = await app.inject({
      method: 'PUT', url: body.uploadUrl.replace('http://api.test', ''),
      headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('seed-image'),
    })
    expect(put.statusCode).toBe(200)
    expect(await readFile(join(process.env.MEDIA_DIR!, 'public', 'profile-photos', ...claim!.p.split('/')), 'utf8'))
      .toBe('seed-image')
    const get = await app.inject({ method: 'GET', url: body.publicUrl.replace('http://api.test', '') })
    expect(get.statusCode).toBe(200)
    expect(get.rawPayload.toString()).toBe('seed-image')
  })

  it('500s when the signed upload URL cannot be created', async () => {
    vi.mocked(storage.createSignedUploadUrl).mockImplementationOnce(() => { throw new Error('boom') })

    const res = await app.inject({
      method: 'POST', url: '/admin/uploads/image-url', headers, payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'upload_url_failed' })
  })
})
