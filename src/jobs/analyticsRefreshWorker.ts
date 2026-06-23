import { parseCronToInterval } from './scheduler.js'
import type { AnalyticsService } from '../services/analytics/service.js'
import type { AnalyticsRefreshMetrics } from './analyticsRefreshMetrics.js'

export interface AnalyticsRefreshWorkerResult {
  refreshed: boolean
  duration: number
  startTime: string
  error?: string
}

export class AnalyticsRefreshWorker {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly logger: (message: string) => void = () => {},
    private readonly metrics?: AnalyticsRefreshMetrics,
  ) {}

  async run(): Promise<AnalyticsRefreshWorkerResult> {
    const startMs = Date.now()
    const startTime = new Date().toISOString()

    this.logger('Starting analytics materialized view refresh')

    try {
      // REFRESH MATERIALIZED VIEW CONCURRENTLY only holds a ShareUpdateExclusiveLock
      // so readers are never blocked during the refresh.
      await this.analyticsService.refreshConcurrently()

      const durationMs = Date.now() - startMs
      const durationSeconds = durationMs / 1000

      this.metrics?.incRuns('success')
      this.metrics?.observeDuration(durationSeconds)
      this.logger(`Analytics refresh completed in ${durationMs}ms`)

      return { refreshed: true, duration: durationMs, startTime }
    } catch (error) {
      const durationMs = Date.now() - startMs
      const errorMessage = error instanceof Error ? error.message : 'Unknown refresh error'

      this.metrics?.incRuns('error')
      this.metrics?.observeDuration(durationMs / 1000)
      this.logger(`Analytics refresh failed after ${durationMs}ms: ${errorMessage}`)

      return { refreshed: false, duration: durationMs, startTime, error: errorMessage }
    }
  }
}

export function getAnalyticsRefreshIntervalMs(cronExpression?: string): number {
  const expr = cronExpression ?? (process.env['ANALYTICS_REFRESH_CRON'] ?? '*/5 * * * *')
  if (expr === '*/5 * * * *') {
    return 5 * 60 * 1000
  }
  return parseCronToInterval(expr)
}
