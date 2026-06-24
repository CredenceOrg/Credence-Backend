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
 * HTTP request latency histogram for SLA tracking (p50, p95, p99).
 * Histograms allow for aggregation across multiple instances.
 *
 * Buckets are tuned for API latency: 5ms to 10s with high resolution
 * around the 250ms SLO target.
 */
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
  ],
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
