import type { AnalyticsRefreshWorker, AnalyticsRefreshWorkerResult } from './analyticsRefreshWorker.js'
import type { DistributedLock } from './distributedLock.js'
import type {
  AnalyticsRefreshMetrics,
  SchedulerSkipReason,
} from './analyticsRefreshMetrics.js'
import type { ViewRefreshOutcome } from '../services/analytics/refreshStrategy.js'

export interface AnalyticsRefreshSchedulerOptions {
  /** Interval between ticks. Should be >> expected refresh duration. */
  intervalMs: number
  /** Run once at start(). Default: false. */
  runOnStart?: boolean
  logger?: (message: string) => void
  /** Optional distributed lock for multi-replica deployments. */
  distributedLock?: DistributedLock
  /** Lock key. Default: `cron:analytics-refresh`. */
  lockKey?: string
  /**
   * Lock TTL in ms. Must exceed the worst-case refresh duration so the
   * heartbeat has time to extend. Default: `Math.min(intervalMs * 5, 600_000)`.
   */
  lockTtlMs?: number
  metrics?: AnalyticsRefreshMetrics
  /**
   * Consecutive failures before a view enters cooldown. Default: 3.
   */
  failCooldownThreshold?: number
  /**
   * Cooldown window in ms after the threshold is tripped. Default: 60_000.
   */
  failCooldownMs?: number
  /**
   * Injectable clock for deterministic tests. Default: `Date.now`.
   */
  clock?: () => number
}

export interface SchedulerStatus {
  active: boolean
  isRunning: boolean
  lastResult: AnalyticsRefreshWorkerResult | null
  runCount: number
  /** Per-view consecutive-failure counter. */
  cooldownStreaks: Record<string, { count: number; firstFailureAt: number | null }>
}

/**
 * Internal: per-view consecutive-failure streak.
 */
interface FailureStreak {
  count: number
  /** `null` if no failures recorded yet. */
  firstFailureAt: number | null
}

const DEFAULT_FAIL_COOLDOWN_THRESHOLD = 3
const DEFAULT_FAIL_COOLDOWN_MS = 60_000
const DEFAULT_LOCK_TTL_CAP_MS = 600_000

/**
 * Drives the analytics refresh worker on an interval, gates with the
 * `overlap` / `lock_contention` / `cooldown` invariants, and tracks
 * consecutive failures per view across runs so a persistent problem
 * doesn't keep burning the database every tick.
 */
export class AnalyticsRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private lastResult: AnalyticsRefreshWorkerResult | null = null
  private runCount = 0
  private consecutiveFailureStreaks: Map<string, FailureStreak> = new Map()

  private readonly intervalMs: number
  private readonly runOnStart: boolean
  private readonly logger: (message: string) => void
  private readonly distributedLock?: DistributedLock
  private readonly lockKey: string
  private readonly lockTtlMs: number
  private readonly metrics?: AnalyticsRefreshMetrics
  private readonly failCooldownThreshold: number
  private readonly failCooldownMs: number
  private readonly clock: () => number

  constructor(
    private readonly worker: AnalyticsRefreshWorker,
    options: AnalyticsRefreshSchedulerOptions,
  ) {
    this.intervalMs = options.intervalMs
    this.runOnStart = options.runOnStart ?? false
    this.logger = options.logger ?? (() => {})
    this.distributedLock = options.distributedLock
    this.lockKey = options.lockKey ?? 'cron:analytics-refresh'
    this.lockTtlMs =
      options.lockTtlMs ?? Math.min(options.intervalMs * 5, DEFAULT_LOCK_TTL_CAP_MS)
    this.metrics = options.metrics
    this.failCooldownThreshold =
      options.failCooldownThreshold ?? DEFAULT_FAIL_COOLDOWN_THRESHOLD
    this.failCooldownMs = options.failCooldownMs ?? DEFAULT_FAIL_COOLDOWN_MS
    this.clock = options.clock ?? (() => Date.now())
  }

  start(): void {
    if (this.intervalId) {
      this.logger('[AnalyticsRefreshScheduler] Already running')
      return
    }

    this.logger(
      `[AnalyticsRefreshScheduler] Starting: interval=${this.intervalMs}ms lockTtl=${this.lockTtlMs}ms cooldownThreshold=${this.failCooldownThreshold} cooldown=${this.failCooldownMs}ms`,
    )

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

  /**
   * True if a worker invocation is currently executing. The graceful
   * shutdown coordinator uses this to wait for in-flight work to drain.
   */
  isJobRunning(): boolean {
    return this.isRunning
  }

  getStatus(): SchedulerStatus {
    const cooldownStreaks: SchedulerStatus['cooldownStreaks'] = {}
    for (const [view, streak] of this.consecutiveFailureStreaks) {
      cooldownStreaks[view] = { count: streak.count, firstFailureAt: streak.firstFailureAt }
    }
    return {
      active: this.isActive(),
      isRunning: this.isRunning,
      lastResult: this.lastResult,
      runCount: this.runCount,
      cooldownStreaks,
    }
  }

  /**
   * Public for tests and admin endpoints: which views are currently in
   * cooldown (and when their first consecutive failure was recorded).
   */
  getViewsInCooldown(now: number = this.clock()): string[] {
    const out: string[] = []
    for (const [view, streak] of this.consecutiveFailureStreaks) {
      if (this.isViewInCooldown(streak, now)) out.push(view)
    }
    return out
  }

  private async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger('[AnalyticsRefreshScheduler] Skipping tick: refresh already in progress')
      this.recordSkip('overlap')
      return
    }

    if (this.isAnyViewInCooldown()) {
      const inCooldown = this.getViewsInCooldown()
      this.logger(
        `[AnalyticsRefreshScheduler] Skipping tick: ${inCooldown.length} view(s) in consecutive-failure cooldown: ${inCooldown.join(',')}`,
      )
      this.recordSkip('cooldown')
      return
    }

    if (this.distributedLock) {
      const { executed } = await this.distributedLock.withLock(
        this.lockKey,
        () => this.runWorker(),
        { ttlMs: this.lockTtlMs, logger: this.logger },
      )

      if (!executed) {
        this.logger('[AnalyticsRefreshScheduler] Skipping tick: lock held by another replica')
        this.recordSkip('lock_contention')
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
      this.updateConsecutiveFailureStreaks(result)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Apply the result of the last tick to the streak counter and the
   * `analytics_refresh_consecutive_failures` gauge:
   * - Refreshed views: streak reset to 0.
   * - Failed views: streak incremented; `firstFailureAt` recorded on the
   *   first hit of `failCooldownThreshold` consecutive failures.
   *
   * If the worker crashed (no outcomes), we leave the streaks as-is so a
   * transient crash doesn't burn down cooldown on otherwise-recovering
   * views.
   */
  private updateConsecutiveFailureStreaks(result: AnalyticsRefreshWorkerResult): void {
    const refreshedSet = new Set(result.refreshedViews)
    const failedByName = new Map<string, ViewRefreshOutcome>()
    for (const failed of result.failedViews) failedByName.set(failed.view, failed)

    // Reset streaks for refreshed views.
    for (const view of refreshedSet) {
      this.consecutiveFailureStreaks.set(view, { count: 0, firstFailureAt: null })
      this.metrics?.setConsecutiveFailures(view, 0)
    }

    // Increment streaks for failed views.
    for (const [view, _outcome] of failedByName) {
      const prior = this.consecutiveFailureStreaks.get(view) ?? { count: 0, firstFailureAt: null }
      const nextCount = prior.count + 1
      const firstFailureAt =
        prior.count >= this.failCooldownThreshold - 1 ? prior.firstFailureAt : this.clock()
      const next: FailureStreak = {
        count: nextCount,
        firstFailureAt: typeof firstFailureAt === 'number' ? firstFailureAt : prior.firstFailureAt,
      }
      this.consecutiveFailureStreaks.set(view, next)
      this.metrics?.setConsecutiveFailures(view, nextCount)
    }
  }

  private isViewInCooldown(streak: FailureStreak, now: number): boolean {
    if (streak.count < this.failCooldownThreshold) return false
    if (streak.firstFailureAt === null) return false
    return now - streak.firstFailureAt < this.failCooldownMs
  }

  private isAnyViewInCooldown(): boolean {
    const now = this.clock()
    for (const streak of this.consecutiveFailureStreaks.values()) {
      if (this.isViewInCooldown(streak, now)) return true
    }
    return false
  }

  private recordSkip(reason: SchedulerSkipReason): void {
    this.metrics?.incSkip(reason)
  }
}
