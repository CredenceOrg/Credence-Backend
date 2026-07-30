import { logger as rootLogger } from '../utils/logger.js'
import {
  AnalyticsRefreshStrategy,
  type Connectable,
  DEFAULT_ANALYTICS_VIEW_SPECS,
  type AnalyticsViewSpec,
  type RefreshStrategyResult,
  type AnalyticsRefreshMetrics,
} from '../services/analytics/refreshStrategy.js'

/**
 * Result of a single worker invocation. Carries enough structure for the
 * scheduler to maintain its consecutive-failure counter and for operators
 * to debug a failed tick from logs alone.
 */
export interface AnalyticsRefreshWorkerResult {
  startTime: string
  durationMs: number
  refreshed: boolean
  refreshedViews: string[]
  failedViews: RefreshStrategyResult['failedViews']
  cacheGeneration?: number
  /** Top-level non-fatal error message (e.g. unexpected runtime crash). */
  error?: string
}

export interface AnalyticsRefreshWorkerOptions {
  strategy: AnalyticsRefreshStrategy
  metrics?: AnalyticsRefreshMetrics
  logger?: ((msg: string) => void)
}

/**
 * Thin orchestration layer over the strategy. The worker is intentionally
 * stateful in its *result* (it tracks the last invocation for status
 * queries) but the consecutive-failure counter lives in the scheduler
 * (see `src/jobs/analyticsRefreshScheduler.ts`) so each replica owns its
 * own cooldown decision.
 */
export class AnalyticsRefreshWorker {
  private readonly strategy: AnalyticsRefreshStrategy
  private readonly metrics?: AnalyticsRefreshMetrics
  private readonly log: (msg: string) => void
  private lastResult: AnalyticsRefreshWorkerResult | null = null

  constructor(options: AnalyticsRefreshWorkerOptions) {
    if (!options.strategy) {
      throw new Error('AnalyticsRefreshWorker requires a strategy')
    }
    this.strategy = options.strategy
    this.metrics = options.metrics
    this.log = options.logger ?? ((msg: string) => rootLogger.info(msg))
  }

  async run(): Promise<AnalyticsRefreshWorkerResult> {
    const startMs = Date.now()
    const startTime = new Date(startMs).toISOString()

    this.log('[analytics] worker.run start')

    try {
      const result = await this.strategy.refreshAll()
      const refreshed = result.failedViews.length === 0
      const workerResult: AnalyticsRefreshWorkerResult = {
        startTime,
        durationMs: result.totalDurationMs,
        refreshed,
        refreshedViews: result.refreshedViews,
        failedViews: result.failedViews,
        cacheGeneration: result.cacheGeneration,
      }
      this.lastResult = workerResult
      this.log(
        refreshed
          ? `[analytics] worker.run ok — refreshed=${result.refreshedViews.length} durationMs=${result.totalDurationMs} cacheGen=${result.cacheGeneration}`
          : `[analytics] worker.run degraded — refreshed=${result.refreshedViews.length} failed=${result.failedViews
              .map((v) => v.view)
              .join(',')} durationMs=${result.totalDurationMs}`,
      )
      return workerResult
    } catch (error) {
      const durationMs = Date.now() - startMs
      const message = error instanceof Error ? error.message : String(error)
      const workerResult: AnalyticsRefreshWorkerResult = {
        startTime,
        durationMs,
        refreshed: false,
        refreshedViews: [],
        failedViews: [],
        error: message,
      }
      this.lastResult = workerResult
      this.log(`[analytics] worker.run crashed after ${durationMs}ms: ${message}`)
      return workerResult
    }
  }

  /** Last invocation result, useful for health/status exports. */
  getLastResult(): AnalyticsRefreshWorkerResult | null {
    return this.lastResult
  }
}

/**
 * Factory: builds a worker pointed at a real Postgres pool with default view
 * specs. Tests use the explicit constructor instead so they can inject a
 * stub strategy.
 */
export function createAnalyticsRefreshWorker(options: {
  pool: Connectable
  views?: AnalyticsViewSpec[]
  maxAttemptsPerView?: number
  retryBackoffMs?: number
  metrics?: AnalyticsRefreshMetrics
  logger?: (msg: string) => void
}): AnalyticsRefreshWorker {
  const strategy = new AnalyticsRefreshStrategy({
    pool: options.pool,
    views: options.views ?? [...DEFAULT_ANALYTICS_VIEW_SPECS],
    maxAttemptsPerView: options.maxAttemptsPerView,
    retryBackoffMs: options.retryBackoffMs,
    metrics: options.metrics,
    logger: options.logger,
  })
  return new AnalyticsRefreshWorker({ strategy, metrics: options.metrics, logger: options.logger })
}
