import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import net from 'node:net'
import type { FastifyBaseLogger } from 'fastify'

import { WEBHOOK_ROUTE_PREFIX } from '../src/webhookRoute.js'
import { registry, registerHttpMetrics, trackJob, startMetricsServer, initJobMetrics } from '../src/metrics.js'
import { fakeLikerRunFailed } from '../src/jobs/fakeLiker.js'
import { buildApp } from '../src/server.js'
import { resetDb } from './helpers/db.js'

const makeLog = () =>
  ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger & {
    error: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  }

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

  it('webhook route label hides the secret', async () => {
    const app = Fastify()
    registerHttpMetrics(app)
    app.post(`${WEBHOOK_ROUTE_PREFIX}/abc123secret`, async () => ({ ok: true }))
    await app.inject({ method: 'POST', url: `${WEBHOOK_ROUTE_PREFIX}/abc123secret` })
    const out = await registry.getSingleMetricAsString('luma_http_request_duration_seconds')
    expect(out).toContain(`route="${WEBHOOK_ROUTE_PREFIX}/:secret"`)
    expect(out).not.toContain('abc123secret')
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

  it('initJobMetrics exposes zero failures and a boot-time last success', async () => {
    initJobMetrics(['init_x'])
    const out = await registry.metrics()
    expect(out).toContain('luma_job_failures_total{job="init_x"} 0')
    const m = out.match(/luma_job_last_success_timestamp_seconds\{job="init_x"\} ([\d.e+]+)/)
    expect(m).not.toBeNull()
    expect(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5)
  })

  it('initJobMetrics then a failure counts 1', async () => {
    initJobMetrics(['init_y'])
    await expect(trackJob('init_y', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const fails = await registry.getSingleMetricAsString('luma_job_failures_total')
    expect(fails).toMatch(/luma_job_failures_total\{job="init_y"\} 1/)
  })

  it('fakeLikerRunFailed: whole-run failure only', () => {
    const base = { likesSent: 0, matchesCreated: 0, salamsSent: 0, skipped: 0, errors: 0 }
    expect(fakeLikerRunFailed({ ...base, errors: 1 })).toBe(true)
    expect(fakeLikerRunFailed({ ...base, errors: 2, likesSent: 3 })).toBe(false)
    expect(fakeLikerRunFailed(base)).toBe(false)
    expect(fakeLikerRunFailed({ skipped: 'disabled' })).toBe(false)
  })

  it('metrics server rejects an invalid port with a warning', () => {
    for (const bad of [NaN, 0, -1, 1.5, 70000]) {
      const log = makeLog()
      expect(startMetricsServer(bad, log)).toBeNull()
      expect(log.warn).toHaveBeenCalled()
    }
  })

  it('metrics server serves /metrics only', async () => {
    const probe = net.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const freePort = (probe.address() as net.AddressInfo).port
    await new Promise((r) => probe.close(r))
    const server = startMetricsServer(freePort, makeLog())!
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
    await app.close()
    // unauthenticated unknown paths hit the auth preHandler first (401), which is fine: never 200
    expect([401, 404]).toContain(res.statusCode)
    expect(res.body).not.toContain('nodejs_')
    expect(res.body).not.toContain('luma_http')
  })
})
