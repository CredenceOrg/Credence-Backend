/**
 * Middleware for tracking percentile latency metrics.
 * 
 * Integrates with Express to record p50, p95, p99 latencies
 * using safe route templates to prevent cardinality explosion.
 */

import { metricsMiddleware as latencyMetricsMiddleware } from './metrics.js'

/**
 * Re-export of main metrics middleware for backward compatibility.
 * SLA metrics (histograms and status class counters) are now integrated into the central metrics middleware.
 * 
 * @deprecated Use metricsMiddleware from ./metrics.js instead.
 */
export { latencyMetricsMiddleware }
