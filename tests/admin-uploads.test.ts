import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'

const SIGNED_URL = 'https://supabase.example.com/signed-upload-url'
const PUBLIC_BASE = 'https://supabase.example.com/storage/v1/object/public/profile-photos'

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

  it('returns a signed upload URL and a public URL under seed/', async () => {
    let capturedPath = ''
    const storageMock = {
      createSignedUploadUrl: (path: string) => {
        capturedPath = path
        return Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null })
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `${PUBLIC_BASE}/${path}` } }),
    }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    const res = await app.inject({
      method: 'POST', url: '/admin/uploads/image-url',
      headers, payload: { contentType: 'image/jpeg' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.uploadUrl).toBe(SIGNED_URL)
    expect(capturedPath).toMatch(/^seed\/[0-9a-f-]+\.jpg$/)
    expect(body.publicUrl).toBe(`${PUBLIC_BASE}/${capturedPath}`)
    expect(vi.mocked(db.storage.from)).toHaveBeenCalledWith('profile-photos')
  })

  it('500s when the storage client errors', async () => {
    const storageMock = {
      createSignedUploadUrl: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `${PUBLIC_BASE}/${path}` } }),
    }
    vi.mocked(db.storage.from).mockReturnValue(storageMock as any)

    const res = await app.inject({
      method: 'POST', url: '/admin/uploads/image-url', headers, payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'upload_url_failed' })
  })
})
