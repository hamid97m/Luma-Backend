import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import http from 'node:http'
import net from 'node:net'
import type { FastifyBaseLogger } from 'fastify'

import { registry, registerHttpMetrics, trackJob, startMetricsServer } from '../src/metrics.js'
import { buildApp } from '../src/server.js'
import { resetDb } from './helpers/db.js'

const makeLog = () =>
  ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> }

describe('metrics', () => {
  it('records matched routes by pattern', async () => {
    const app = Fastify()
    registerHttpMetrics(app)
    app.get('/users/:id', async () => ({ ok: true }))
    await app.inject({ method: 'GET', url: '/users/123' })
    const out = await registry.getSingleMetricAsString('luma_http_request_duration_seconds')
    expect(out).toContain('route="/users/:id"')
    expect(out).not.toContain('123')
  })

  it('buckets unknown URLs as unmatched', async () => {
    const app = Fastify()
    registerHttpMetrics(app)
    const res = await app.inject({ method: 'GET', url: '/wp-login.php' })
    expect(res.statusCode).toBe(404)
    const out = await registry.getSingleMetricAsString('luma_http_request_duration_seconds')
    expect(out).toContain('route="unmatched",status_code="404"')
    expect(out).not.toContain('wp-login')
  })

  it('trackJob records success', async () => {
    expect(await trackJob('t_ok', async () => 1)).toBe(1)
    const out = await registry.getSingleMetricAsString('luma_job_last_success_timestamp_seconds')
    const m = out.match(/luma_job_last_success_timestamp_seconds\{job="t_ok"\} ([\d.e+]+)/)
    expect(m).not.toBeNull()
    expect(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5)
  })

  it('trackJob records failure and rethrows', async () => {
    await expect(trackJob('t_fail', () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    const fails = await registry.getSingleMetricAsString('luma_job_failures_total')
    expect(fails).toMatch(/luma_job_failures_total\{job="t_fail"\} 1/)
    const ok = await registry.getSingleMetricAsString('luma_job_last_success_timestamp_seconds')
    expect(ok).not.toContain('t_fail')
  })

  it('metrics server serves /metrics only', async () => {
    const server = startMetricsServer(0, makeLog())!
    expect(server).not.toBeNull()
    await new Promise<void>((r) => server.once('listening', () => r()))
    const port = (server.address() as net.AddressInfo).port
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('nodejs_eventloop_lag')
      const nf = await fetch(`http://127.0.0.1:${port}/`)
      expect(nf.status).toBe(404)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('metrics server survives a busy port', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as net.AddressInfo).port
    const log = makeLog()
    try {
      expect(() => startMetricsServer(port, log)).not.toThrow()
      await vi.waitFor(() => expect(log.error).toHaveBeenCalled())
    } finally {
      await new Promise((r) => blocker.close(r))
    }
  })
})

describe('public app', () => {
  beforeEach(async () => {
    await resetDb()
  })
  it('has no /metrics', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    // unauthenticated unknown paths hit the auth preHandler first (401), which is fine: never 200
    expect([401, 404]).toContain(res.statusCode)
    expect(res.body).not.toContain('nodejs_')
    expect(res.body).not.toContain('luma_http')
  })
})
