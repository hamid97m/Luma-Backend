import http from 'node:http'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { Registry, Histogram, Gauge, Counter, collectDefaultMetrics } from 'prom-client'

export const registry = new Registry()
collectDefaultMetrics({ register: registry })

const httpDuration = new Histogram({
  name: 'luma_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

const jobLastSuccess = new Gauge({
  name: 'luma_job_last_success_timestamp_seconds',
  help: 'Unix time of the last successful run of a scheduled job',
  labelNames: ['job'] as const,
  registers: [registry],
})

const jobFailures = new Counter({
  name: 'luma_job_failures_total',
  help: 'Number of failed runs of a scheduled job',
  labelNames: ['job'] as const,
  registers: [registry],
})

const jobDuration = new Histogram({
  name: 'luma_job_duration_seconds',
  help: 'Scheduled job run duration in seconds',
  labelNames: ['job'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
  registers: [registry],
})

/** Observe every response; `route` is the route pattern, never the raw URL. */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      {
        method: req.method,
        route: req.routeOptions?.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    )
  })
}

export async function trackJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const end = jobDuration.startTimer({ job: name })
  try {
    const result = await fn()
    jobLastSuccess.set({ job: name }, Date.now() / 1000)
    return result
  } catch (err) {
    jobFailures.inc({ job: name })
    throw err
  } finally {
    end()
  }
}

/** Private listener (127.0.0.1 only) serving GET /metrics for Prometheus. */
export function startMetricsServer(port: number, log: FastifyBaseLogger): http.Server | null {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': registry.contentType })
        res.end(await registry.metrics())
      } catch (err) {
        log.error({ err }, 'metrics render failed')
        res.statusCode = 500
        res.end()
      }
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.on('error', (err) => {
    log.error({ err }, 'metrics server failed')
  })
  server.listen(port, '127.0.0.1')
  return server
}
