import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildApp } from '../src/server.js'
import { db } from '../src/db.js'
import { signAdminToken } from '../src/routes/admin/auth-utils.js'
import { chainable } from './admin-helpers.js'

describe('admin moderation config', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = { authorization: `Bearer ${signAdminToken({ adminId: 'a1', username: 'root' })}` }
  })

  it('returns the current threshold', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      chainable({ data: { photo_report_threshold: 3 }, error: null }))
    const res = await app.inject({ method: 'GET', url: '/admin/moderation/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ photoReportThreshold: 3 })
  })

  it('updates the threshold', async () => {
    const update = vi.fn(() => chainable({ data: { photo_report_threshold: 5 }, error: null }))
    vi.mocked(db.from).mockImplementation(() => ({ update } as any))
    const res = await app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers,
      payload: { photoReportThreshold: 5 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ photoReportThreshold: 5 })
    expect((update.mock.calls[0][0] as any).photo_report_threshold).toBe(5)
  })

  it('rejects a negative threshold', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers,
      payload: { photoReportThreshold: -1 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_photo_report_threshold' })
  })

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/moderation/config' })
    expect(res.statusCode).toBe(401)
  })
})
