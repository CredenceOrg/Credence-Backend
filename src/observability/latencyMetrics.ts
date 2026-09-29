/**
 * Percentile latency metrics with safe route templates.
 *
 * Prevents cardinality explosion by normalizing dynamic route segments
 * (e.g., /api/trust/0x123 → /api/trust/:address) and by capping the number
 * of unique route templates that can enter Prometheus labels.
 */

import { Request } from 'express'
import client from 'prom-client'

/**
 * Hard limit on unique route templates tracked in Prometheus labels.
 *
 * Cardinality formula: methods(~10) × routes(≤50) × status_classes(5) = ~2,500 series.
 * Any route template seen after this cap is bucketed under the overflow sentinel
 * `_overflow` so Prometheus series counts remain bounded even if an attacker or
 * misconfigured client hits arbitrary paths.
 *
 * @see docs/sla-metrics.md — Cardinality Policy section
 */
export const MAX_ROUTE_CARDINALITY = 50

/**
 * Sentinel label value used when the unique-template cap is exceeded.
 * Operators can alert on a spike in `route="_overflow"` to detect new
 * unparameterised paths escaping normalisation.
 */
export const OVERFLOW_ROUTE_LABEL = '_overflow'

/** Internal set tracking all route templates seen so far. */
const _seenRoutes = new Set<string>()

/**
 * Normalizes Express routes to template form to prevent cardinality explosion.
 *
 * Resolution order (highest priority first):
 * 1. Express router template — already parameterised (`:address`, `:id`, etc.)
 * 2. Pattern-based fallback for paths not matched by any router
 * 3. Overflow sentinel if unique template count exceeds MAX_ROUTE_CARDINALITY
 *
 * Normalised patterns:
 * - Ethereum/hex addresses  `/0x[a-fA-F0-9]+`  → `/:address`
 * - Stellar G-addresses     `/G[A-Z2-7]{55}`   → `/:address`
 * - UUIDs (v1–v5)           `/<uuid>`          → `/:id`
 * - Numeric IDs             `/\d+`             → `/:id`
 *
 * @param path      Raw request path (`req.path` or `req.baseUrl + req.path`)
 * @param routePath Pre-templated path from Express router (`req.route.path`)
 */
export function normalizeRoute(path: string, routePath?: string): string {
  const candidate = routePath
    ? routePath
    : path
        .replace(/\/0x[a-fA-F0-9]+/g, '/:address')
        .replace(/\/G[A-Z2-7]{55}/g, '/:address')
        .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:id')
        .replace(/\/\d+/g, '/:id')

  if (_seenRoutes.has(candidate)) return candidate

  if (_seenRoutes.size >= MAX_ROUTE_CARDINALITY) return OVERFLOW_ROUTE_LABEL

  _seenRoutes.add(candidate)
  return candidate
}

/**
 * Resets the seen-routes set used by the overflow guard.
 *
 * Intended only for tests — call this in `beforeEach` when you need a clean
 * cardinality slate between test cases.
 */
export function _resetSeenRoutes(): void {
  _seenRoutes.clear()
}

/**
 * Extracts the fully-qualified route template from an Express request.
 *
 * Express sub-routers strip the mount prefix from `req.route.path`.  For
 * example, a router mounted at `/api` with a route `/:address` will set
 * `req.route.path` to `/:address`, not `/api/:address`.  This helper
 * reconstructs the full path from `req.baseUrl + req.route.path`.
 *
 * Falls back to `normalizeRoute(req.path)` when no route has been matched yet
 * (e.g. 404 or pre-route middleware).
 *
 * @example
 *   // GET /api/trust/0xDeAdBeEf → "/api/trust/:address"
 *   const template = getRouteTemplate(req)
 */
export function getRouteTemplate(req: Request): string {
  if (req.route?.path) {
    // req.baseUrl is the mount prefix (e.g. "/api/trust"); req.route.path is
    // the matched pattern within that router (e.g. "/:address").
    const fullTemplate = (req.baseUrl ?? '') + req.route.path
    return normalizeRoute(fullTemplate, fullTemplate)
  }
  // No matched route — fall back to pattern-based normalisation on the raw path.
  return normalizeRoute((req.baseUrl ?? '') + req.path)
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
