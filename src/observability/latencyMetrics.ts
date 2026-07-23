/**
 * Percentile latency metrics with safe route templates.
 * 
 * Prevents cardinality explosion by normalizing dynamic route segments
 * (e.g., /api/trust/0x123 → /api/trust/:address).
 */

import client from 'prom-client'

/**
 * Normalizes Express routes to template form to prevent cardinality explosion.
 * 
 * Examples:
 * - /api/trust/0x123abc → /api/trust/:address
 * - /api/bond/stellar123 → /api/bond/:address
 * - /api/attestations/0xabc/verify → /api/attestations/:address/verify
 * 
 * Cardinality policy:
 * - Use req.route.path when available (already templated by Express)
 * - Fallback to req.path for unmatched routes
 * - Max unique routes: ~50 (bounded by API surface)
 */
export function normalizeRoute(path: string, routePath?: string): string {
  if (routePath) return routePath
  
  // Fallback normalization for unmatched routes
  return path
    .replace(/\/0x[a-fA-F0-9]+/g, '/:address')
    .replace(/\/G[A-Z2-7]{55}/g, '/:address')
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
}

/**
 * Histogram bucket boundaries (in seconds) for HTTP request latency.
 *
 * The three SLO fence-posts are kept as explicit values so that
 * histogram_quantile() and range queries can produce exact counts at each
 * documented threshold without interpolation:
 *
 *   0.2  s  →  200 ms  cache-operation SLO target
 *   0.5  s  →  500 ms  queue-operation SLO target
 *   1.0  s  → 1000 ms  database-operation SLO target / p99 alert threshold
 *
 * Defined once here and reused by the histogram definition, tests, and docs
 * so the boundaries never drift out of sync.
 *
 * @see src/lib/timeouts.ts   DEFAULT_TIMEOUT_BUDGETS for the source SLO values
 * @see docs/SLO.md           Latency SLO definitions
 * @see docs/sla-metrics.md   Metric documentation and PromQL examples
 */
export const HTTP_LATENCY_BUCKETS_S = [
  0.005, 0.01, 0.025, 0.05, 0.1,
  0.2,  // ← 200 ms — cache SLO target
  0.5,  // ← 500 ms — queue SLO target
  1,    // ← 1000 ms — database SLO target & p99 alert threshold
  2.5, 5, 10,
]

/**
 * HTTP request latency histogram for SLA tracking (p50, p95, p99).
 * Histograms allow for aggregation across multiple instances.
 *
 * Buckets are defined by HTTP_LATENCY_BUCKETS_S, with explicit fence-posts
 * at the 200 ms, 500 ms, and 1000 ms SLO boundaries so that compliance
 * queries and alerts land on exact bucket edges.
 */
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: HTTP_LATENCY_BUCKETS_S,
})

/**
 * Counter for requests by status class to track error rates in SLOs.
 */
export const httpRequestStatusTotal = new client.Counter({
  name: 'http_requests_status_total',
  help: 'Total number of HTTP requests by status class',
  labelNames: ['method', 'route', 'status_class'],
})

/**
 * Registers the latency metrics with the provided registry.
 */
export function registerLatencyMetrics(registry: client.Registry): void {
  registry.registerMetric(httpRequestDurationHistogram)
  registry.registerMetric(httpRequestStatusTotal)
}
