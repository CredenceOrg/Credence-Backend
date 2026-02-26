/**
 * Prometheus metrics middleware for Credence Backend
 * 
 * This is an example implementation. To use:
 * 1. Install prom-client: npm install prom-client
 * 2. Rename this file to metrics.ts
 * 3. Import and use in src/index.ts
 * 
 * See docs/monitoring.md for complete setup instructions
 */

import { Request, Response, NextFunction } from 'express'
import client from 'prom-client'

// Create a Registry to register metrics
export const register = new client.Registry()

// Add default Node.js metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ 
  register,
  prefix: 'nodejs_'
})

// ============================================================================
// HTTP Metrics
// ============================================================================

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
})

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
})

// ============================================================================
// Health Check Metrics
// ============================================================================

export const healthCheckStatus = new client.Gauge({
  name: 'health_check_status',
  help: 'Health check status (1 = up, 0 = down)',
  labelNames: ['dependency'],
  registers: [register]
})

export const healthCheckDuration = new client.Gauge({
  name: 'health_check_duration_seconds',
  help: 'Duration of health checks in seconds',
  labelNames: ['dependency'],
  registers: [register]
})

// ============================================================================
// Business Metrics
// ============================================================================

export const reputationScoreCalculations = new client.Counter({
  name: 'reputation_score_calculations_total',
  help: 'Total number of reputation score calculations',
  registers: [register]
})

export const reputationCalculationDuration = new client.Histogram({
  name: 'reputation_calculation_duration_seconds',
  help: 'Duration of reputation calculations in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
})

export const identityVerifications = new client.Counter({
  name: 'identity_verifications_total',
  help: 'Total number of identity verifications',
  labelNames: ['status'],
  registers: [register]
})

export const bulkVerifications = new client.Counter({
  name: 'bulk_verifications_total',
  help: 'Total number of bulk verification requests',
  labelNames: ['status'],
  registers: [register]
})

export const bulkVerificationBatchSize = new client.Histogram({
  name: 'bulk_verification_batch_size',
  help: 'Size of bulk verification batches',
  buckets: [1, 5, 10, 25, 50, 75, 100],
  registers: [register]
})

export const identitySyncDuration = new client.Histogram({
  name: 'identity_sync_duration_seconds',
  help: 'Duration of identity state sync operations',
  labelNames: ['operation'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
})

// ============================================================================
// Middleware
// ============================================================================

/**
 * Express middleware to track HTTP request metrics
 * 
 * Usage:
 * ```typescript
 * import { metricsMiddleware } from './middleware/metrics.js'
 * app.use(metricsMiddleware)
 * ```
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    const route = req.route?.path || req.path
    
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status: res.statusCode
    })
    
    httpRequestDuration.observe({
      method: req.method,
      route,
      status: res.statusCode
    }, duration)
  })
  
  next()
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record health check result
 * 
 * Usage:
 * ```typescript
 * import { recordHealthCheck } from './middleware/metrics.js'
 * 
 * const start = Date.now()
 * const isUp = await checkDatabase()
 * recordHealthCheck('db', isUp, Date.now() - start)
 * ```
 */
export function recordHealthCheck(
  dependency: string,
  isUp: boolean,
  durationMs: number
) {
  healthCheckStatus.set({ dependency }, isUp ? 1 : 0)
  healthCheckDuration.set({ dependency }, durationMs / 1000)
}

/**
 * Record reputation calculation
 * 
 * Usage:
 * ```typescript
 * import { recordReputationCalculation } from './middleware/metrics.js'
 * 
 * const start = Date.now()
 * const score = calculateReputationScore(input)
 * recordReputationCalculation(Date.now() - start)
 * ```
 */
export function recordReputationCalculation(durationMs: number) {
  reputationScoreCalculations.inc()
  reputationCalculationDuration.observe(durationMs / 1000)
}

/**
 * Record identity verification
 * 
 * Usage:
 * ```typescript
 * import { recordIdentityVerification } from './middleware/metrics.js'
 * 
 * try {
 *   await verifyIdentity(address)
 *   recordIdentityVerification('success')
 * } catch (error) {
 *   recordIdentityVerification('error')
 * }
 * ```
 */
export function recordIdentityVerification(status: 'success' | 'error') {
  identityVerifications.inc({ status })
}

/**
 * Record bulk verification
 * 
 * Usage:
 * ```typescript
 * import { recordBulkVerification } from './middleware/metrics.js'
 * 
 * recordBulkVerification(addresses.length, 'success')
 * ```
 */
export function recordBulkVerification(
  batchSize: number,
  status: 'success' | 'error'
) {
  bulkVerifications.inc({ status })
  bulkVerificationBatchSize.observe(batchSize)
}

/**
 * Record identity sync operation
 * 
 * Usage:
 * ```typescript
 * import { recordIdentitySync } from './middleware/metrics.js'
 * 
 * const start = Date.now()
 * await sync.reconcileByAddress(address)
 * recordIdentitySync('reconcile', Date.now() - start)
 * ```
 */
export function recordIdentitySync(
  operation: 'reconcile' | 'full_resync',
  durationMs: number
) {
  identitySyncDuration.observe({ operation }, durationMs / 1000)
}
