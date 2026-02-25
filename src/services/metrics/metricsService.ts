import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client'
import { MetricEvent } from './types.js'
import type { HttpRequestMetadata } from './types.js'

/**
 * Prometheus metrics service for tracking application metrics
 * 
 * Provides:
 * - HTTP request metrics (duration, count by route and status)
 * - Business metrics (bonds, slashes, score calculations)
 * - Default Node.js metrics (memory, CPU, event loop)
 */
export class MetricsService {
  private registry: Registry
  private httpRequestDuration: Histogram
  private httpRequestTotal: Counter
  private bondEventsTotal: Counter
  private slashEventsTotal: Counter
  private scoreCalculationsTotal: Counter
  private identityVerificationsTotal: Counter
  private bulkVerificationsTotal: Counter
  private activeBondsGauge: Gauge
  private totalBondedAmountGauge: Gauge

  constructor() {
    this.registry = new Registry()

    // Collect default Node.js metrics (memory, CPU, etc.)
    collectDefaultMetrics({ register: this.registry })

    // HTTP request duration histogram
    // Buckets: 10ms, 50ms, 100ms, 500ms, 1s, 5s, 10s
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      registers: [this.registry],
    })

    // HTTP request counter
    this.httpRequestTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    })

    // Business metrics - Counters
    this.bondEventsTotal = new Counter({
      name: 'bond_events_total',
      help: 'Total number of bond creation events',
      labelNames: ['address'],
      registers: [this.registry],
    })

    this.slashEventsTotal = new Counter({
      name: 'slash_events_total',
      help: 'Total number of slash events',
      labelNames: ['reason'],
      registers: [this.registry],
    })

    this.scoreCalculationsTotal = new Counter({
      name: 'score_calculations_total',
      help: 'Total number of trust score calculations',
      labelNames: ['address'],
      registers: [this.registry],
    })

    this.identityVerificationsTotal = new Counter({
      name: 'identity_verifications_total',
      help: 'Total number of identity verifications',
      labelNames: ['status'],
      registers: [this.registry],
    })

    this.bulkVerificationsTotal = new Counter({
      name: 'bulk_verifications_total',
      help: 'Total number of bulk verification requests',
      labelNames: ['batch_size_range'],
      registers: [this.registry],
    })

    // Business metrics - Gauges
    this.activeBondsGauge = new Gauge({
      name: 'active_bonds_count',
      help: 'Current number of active bonds',
      registers: [this.registry],
    })

    this.totalBondedAmountGauge = new Gauge({
      name: 'total_bonded_amount',
      help: 'Total amount of XLM currently bonded',
      registers: [this.registry],
    })
  }

  /**
   * Record HTTP request metrics
   * 
   * @param metadata - Request metadata (method, route, status, duration)
   * 
   * @example
   * ```typescript
   * metricsService.recordHttpRequest({
   *   method: 'GET',
   *   route: '/api/trust/:address',
   *   statusCode: 200,
   *   durationMs: 45
   * })
   * ```
   */
  recordHttpRequest(metadata: HttpRequestMetadata): void {
    const { method, route, statusCode, durationMs } = metadata
    const durationSeconds = durationMs / 1000

    this.httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      durationSeconds
    )

    this.httpRequestTotal.inc({ method, route, status_code: statusCode })
  }

  /**
   * Record business event metric
   * 
   * @param event - Type of business event
   * @param labels - Additional labels for the metric
   * 
   * @example
   * ```typescript
   * metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, { address: 'GABC...' })
   * metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, { reason: 'fraud' })
   * ```
   */
  recordBusinessEvent(event: MetricEvent, labels: Record<string, string> = {}): void {
    switch (event) {
      case MetricEvent.BOND_CREATED:
        this.bondEventsTotal.inc({ address: labels.address || 'unknown' })
        break
      case MetricEvent.BOND_SLASHED:
        this.slashEventsTotal.inc({ reason: labels.reason || 'unknown' })
        break
      case MetricEvent.SCORE_CALCULATED:
        this.scoreCalculationsTotal.inc({ address: labels.address || 'unknown' })
        break
      case MetricEvent.IDENTITY_VERIFIED:
        this.identityVerificationsTotal.inc({ status: labels.status || 'unknown' })
        break
      case MetricEvent.BULK_VERIFICATION:
        this.bulkVerificationsTotal.inc({ batch_size_range: labels.batch_size_range || 'unknown' })
        break
    }
  }

  /**
   * Update active bonds gauge
   * 
   * @param count - Current number of active bonds
   * 
   * @example
   * ```typescript
   * metricsService.setActiveBonds(150)
   * ```
   */
  setActiveBonds(count: number): void {
    this.activeBondsGauge.set(count)
  }

  /**
   * Update total bonded amount gauge
   * 
   * @param amount - Total XLM bonded
   * 
   * @example
   * ```typescript
   * metricsService.setTotalBondedAmount(1000000.50)
   * ```
   */
  setTotalBondedAmount(amount: number): void {
    this.totalBondedAmountGauge.set(amount)
  }

  /**
   * Get metrics in Prometheus format
   * 
   * @returns Prometheus-formatted metrics string
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics()
  }

  /**
   * Get the registry instance (for testing)
   * 
   * @returns Prometheus registry
   */
  getRegistry(): Registry {
    return this.registry
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.registry.resetMetrics()
  }
}

// Singleton instance
let metricsServiceInstance: MetricsService | null = null

/**
 * Get or create the metrics service singleton
 * 
 * @returns MetricsService instance
 */
export function getMetricsService(): MetricsService {
  if (!metricsServiceInstance) {
    metricsServiceInstance = new MetricsService()
  }
  return metricsServiceInstance
}

/**
 * Reset the metrics service singleton (for testing)
 */
export function resetMetricsService(): void {
  metricsServiceInstance = null
}
