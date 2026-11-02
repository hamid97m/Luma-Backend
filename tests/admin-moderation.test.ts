import { describe, it, expect, beforeEach } from 'vitest'

import { buildApp } from '../src/server.js'
import { resetDb, sql } from './helpers/db.js'
import { adminHeaders } from './helpers/admin.js'
import { withFailingWrite } from './helpers/admin-db-fault.js'

describe('admin moderation config', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let headers: Record<string, string>

  beforeEach(async () => {
    await resetDb()
    process.env.ADMIN_JWT_SECRET = 'test-secret'
    app = await buildApp()
    headers = adminHeaders()
  })

  it('returns the current threshold', async () => {
    await sql`update moderation_config set photo_report_threshold = 4`
    const res = await app.inject({ method: 'GET', url: '/admin/moderation/config', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ photoReportThreshold: 4 })
  })

  it('500s when the config row is missing', async () => {
    await sql`delete from moderation_config`
    const res = await app.inject({ method: 'GET', url: '/admin/moderation/config', headers })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_fetch_failed' })
  })

  it('updates the threshold and updated_at', async () => {
    await sql`update moderation_config set updated_at = '2026-01-01T00:00:00Z'`
    const res = await app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers,
      payload: { photoReportThreshold: 5 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ photoReportThreshold: 5 })
    const [row] = await sql`select photo_report_threshold, updated_at from moderation_config`
    expect(row.photo_report_threshold).toBe(5)
    expect(Date.now() - Date.parse(row.updated_at)).toBeLessThan(5_000)
  })

  it('500s when the update fails', async () => {
    const res = await withFailingWrite('moderation_config', 'update', () => app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers, payload: { photoReportThreshold: 5 },
    }))
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'config_update_failed' })
  })

  it('rejects a negative threshold and an empty update', async () => {
    const neg = await app.inject({
      method: 'PUT', url: '/admin/moderation/config', headers,
      payload: { photoReportThreshold: -1 },
    })
    expect(neg.statusCode).toBe(400)
    expect(neg.json()).toEqual({ error: 'invalid_photo_report_threshold' })
    const empty = await app.inject({ method: 'PUT', url: '/admin/moderation/config', headers, payload: {} })
    expect(empty.json()).toEqual({ error: 'empty_update' })
  })

  it('requires an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/moderation/config' })
    expect(res.statusCode).toBe(401)
  })
})
