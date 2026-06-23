import type { AnalyticsRefreshWorker, AnalyticsRefreshWorkerResult } from './analyticsRefreshWorker.js'
import type { DistributedLock } from './distributedLock.js'
import type { AnalyticsRefreshMetrics } from './analyticsRefreshMetrics.js'

export interface AnalyticsRefreshSchedulerOptions {
  intervalMs: number
  runOnStart?: boolean
  logger?: (message: string) => void
  distributedLock?: DistributedLock
  lockKey?: string
  /** Lock TTL in ms. Must exceed the expected refresh duration. Defaults to min(5×intervalMs, 2min). */
  lockTtlMs?: number
  metrics?: AnalyticsRefreshMetrics
}

export interface SchedulerStatus {
  active: boolean
  isRunning: boolean
  lastResult: AnalyticsRefreshWorkerResult | null
  runCount: number
}

export class AnalyticsRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private lastResult: AnalyticsRefreshWorkerResult | null = null
  private runCount = 0

  private readonly intervalMs: number
  private readonly runOnStart: boolean
  private readonly logger: (message: string) => void
  private readonly distributedLock?: DistributedLock
  private readonly lockKey: string
  private readonly lockTtlMs: number
  private readonly metrics?: AnalyticsRefreshMetrics

  constructor(
    private readonly worker: AnalyticsRefreshWorker,
    options: AnalyticsRefreshSchedulerOptions,
  ) {
    this.intervalMs = options.intervalMs
    this.runOnStart = options.runOnStart ?? false
    this.logger = options.logger ?? (() => {})
    this.distributedLock = options.distributedLock
    this.lockKey = options.lockKey ?? 'cron:analytics-refresh'
    this.lockTtlMs = options.lockTtlMs ?? Math.min(options.intervalMs * 5, 120_000)
    this.metrics = options.metrics
  }

  start(): void {
    if (this.intervalId) {
      this.logger('[AnalyticsRefreshScheduler] Already running')
      return
    }

    this.logger(`[AnalyticsRefreshScheduler] Starting with interval ${this.intervalMs}ms`)

    if (this.runOnStart) {
      void this.tick()
    }

    this.intervalId = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.logger('[AnalyticsRefreshScheduler] Stopped')
    }
  }

  isActive(): boolean {
    return this.intervalId !== null
  }

  getStatus(): SchedulerStatus {
    return {
      active: this.isActive(),
      isRunning: this.isRunning,
      lastResult: this.lastResult,
      runCount: this.runCount,
    }
  }

  private async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger('[AnalyticsRefreshScheduler] Skipping tick: refresh already in progress')
      this.metrics?.incSkip('overlap')
      return
    }

    if (this.distributedLock) {
      const { executed } = await this.distributedLock.withLock(
        this.lockKey,
        () => this.runWorker(),
        { ttlMs: this.lockTtlMs, logger: this.logger },
      )

      if (!executed) {
        this.metrics?.incSkip('lock_contention')
        this.logger('[AnalyticsRefreshScheduler] Skipping tick: lock held by another replica')
      }
      return
    }

    await this.runWorker()
  }

  private async runWorker(): Promise<void> {
    this.isRunning = true
    try {
      const result = await this.worker.run()
      this.lastResult = result
      this.runCount++
    } finally {
      this.isRunning = false
    }
  }
}
