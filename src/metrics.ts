import http from 'node:http'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { WEBHOOK_ROUTE_PREFIX } from './webhookRoute.js'
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

const signupEvents = new Counter({
  name: 'luma_signup_events_total',
  help: 'Accepted signup-funnel events',
  labelNames: ['name', 'step'] as const,
  registers: [registry],
})

/** Both labels are allowlisted by the route, so cardinality stays bounded. */
export function countSignupEvent(name: string, step: string | null): void {
  signupEvents.inc({ name, step: step ?? '' })
}

/** Route label: the Telegram webhook path embeds a secret, so collapse it. */
function routeLabel(url: string | undefined): string {
  if (!url) return 'unmatched'
  if (url === WEBHOOK_ROUTE_PREFIX || url.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`)) {
    return `${WEBHOOK_ROUTE_PREFIX}/:secret`
  }
  return url
}

/** Observe every response; `route` is the route pattern, never the raw URL. */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      {
        method: req.method,
        route: routeLabel(req.routeOptions?.url),
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

/**
 * Create every job's series at boot: failures at 0 (so the first real failure shows up in
 * increase()) and last-success at process start (so JobStale counts from boot).
 */
export function initJobMetrics(names: string[]): void {
  const now = Date.now() / 1000
  for (const job of names) {
    jobFailures.inc({ job }, 0)
    jobLastSuccess.set({ job }, now)
  }
}

/** Private listener (127.0.0.1 only) serving GET /metrics for Prometheus. */
export function startMetricsServer(port: number, log: FastifyBaseLogger): http.Server | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    log.warn({ port }, 'METRICS_PORT is not a valid port; metrics server not started')
    return null
  }
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/metrics') {
      try {
        const body = await registry.metrics()
        res.writeHead(200, { 'Content-Type': registry.contentType })
        res.end(body)
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

const pushSent = new Counter({
  name: 'luma_push_sent_total',
  help: 'FCM push sends by type and result',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
})

/** `type` is the PushType union, so cardinality stays bounded. */
export function countPushSent(type: string, result: 'ok' | 'dead' | 'failed'): void {
  pushSent.inc({ type, result })
}

const pushConfigErrors = new Counter({
  name: 'luma_push_config_errors_total',
  help: 'FCM 401/403 responses (service-account or project misconfiguration)',
  registers: [registry],
})

export function countPushConfigError(): void {
  pushConfigErrors.inc()
}
