import { randomUUID } from 'crypto'
import type { DistributedLock } from './distributedLock.js'
import { runWithCorrelationIds } from '../utils/logger.js'

export interface SchedulableJob {
  run(): Promise<unknown>
}

/**
 * Minimal Redis interface for idempotency checks — only needs get/set.
 */
export interface IdempotencyRedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { PX: number }): Promise<string | null>
}


/**
 * Scheduler options.
 */
export interface SchedulerOptions {
  /** Cron expression (default: '0 * * * *' - every hour). */
  cronExpression?: string
  /** Whether to run immediately on start (default: false). */
  runOnStart?: boolean
  /** Logger function. */
  logger?: (message: string) => void
  /**
   * Optional distributed lock for multi-worker deployments.
   * When provided, each scheduled invocation acquires the lock before running
   * so only one replica executes the job per interval.
   */
  distributedLock?: DistributedLock
  /**
   * Redis key used as the lock name (required when distributedLock is set).
   * @default 'cron:score-snapshot'
   */
  lockKey?: string
  /**
   * Lock TTL in milliseconds. Should exceed the expected job duration.
   * @default 5 × intervalMs (capped at 10 minutes)
   */
  lockTtlMs?: number
  /**
   * Redis client for idempotency checks. When provided together with
   * enableIdempotency, the scheduler sets a "lastRun" marker after each
   * successful job completion and skips execution if the marker exists
   * (i.e. the job was already run within the interval window).
   */
  redisClient?: IdempotencyRedisClient
  /**
   * Enable idempotency guard using Redis lastRun markers.
   * Requires redisClient to be set.
   * @default false
   */
  enableIdempotency?: boolean
}

/**
 * Job scheduler using simple interval-based scheduling.
 * 
 * For production, consider using a robust scheduler like:
 * - node-cron
 * - Bull queue
 * - Agenda
 * 
 * @example
 * ```typescript
 * const scheduler = new JobScheduler(job, {
 *   intervalMs: 3600000, // 1 hour
 *   runOnStart: true
 * })
 * scheduler.start()
 * ```
 */
export class JobScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private readonly intervalMs: number
  private readonly runOnStart: boolean
  private readonly logger: (message: string) => void
  private readonly distributedLock?: DistributedLock
  private readonly lockKey: string
  private readonly lockTtlMs: number
  private readonly redisClient?: IdempotencyRedisClient
  private readonly enableIdempotency: boolean
  private readonly idempotencyKeyBase: string

  constructor(
    private readonly job: SchedulableJob,
    options: {
      intervalMs: number
      runOnStart?: boolean
      logger?: (message: string) => void
      distributedLock?: DistributedLock
      lockKey?: string
      lockTtlMs?: number
      redisClient?: IdempotencyRedisClient
      enableIdempotency?: boolean
    }
  ) {
    // Node coerces invalid/overflowing delays to 1ms. Reject them before
    // they can accidentally turn a periodic job into a tight retry loop.
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 2_147_483_647) {
      throw new RangeError('intervalMs must be an integer between 1 and 2147483647')
    }
    if (options.lockTtlMs !== undefined && (!Number.isInteger(options.lockTtlMs) || options.lockTtlMs < 1 || options.lockTtlMs > 2_147_483_647)) {
      throw new RangeError('lockTtlMs must be an integer between 1 and 2147483647')
    }
    if (options.enableIdempotency && !options.redisClient) {
      throw new Error('enableIdempotency requires redisClient')
    }
    this.intervalMs = options.intervalMs
    this.runOnStart = options.runOnStart ?? false
    this.logger = options.logger ?? (() => {})
    this.distributedLock = options.distributedLock
    this.lockKey = options.lockKey ?? 'cron:score-snapshot'
    this.lockTtlMs = options.lockTtlMs ?? Math.min(options.intervalMs * 5, 600_000)
    this.redisClient = options.redisClient
    this.enableIdempotency = options.enableIdempotency ?? false
    this.idempotencyKeyBase = `${this.lockKey}:lastRun`
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.intervalId) {
      this.logger('Scheduler already running')
      return
    }

    this.logger(`Starting scheduler with interval ${this.intervalMs}ms`)

    this.intervalId = setInterval(() => {
      void this.runJob()
    }, this.intervalMs)

    if (this.runOnStart) {
      void this.runJob()
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.logger('Scheduler stopped')
    }
  }

  /**
   * Check if scheduler is running.
   */
  isActive(): boolean {
    return this.intervalId !== null
  }

  /**
   * Check if a job invocation is currently executing.
   * Used by the shutdown coordinator to wait for in-flight work to drain.
   */
  isJobRunning(): boolean {
    return this.isRunning
  }

  /**
   * Run the job (internal).
   *
   * When a `distributedLock` is configured the job only runs if this worker
   * can acquire the lock, preventing duplicate execution across replicas.
   * The in-process `isRunning` guard still applies as a secondary safeguard.
   */
  private async runJob(): Promise<void> {
    if (this.isRunning) {
      this.logger('Job already running, skipping this interval')
      return
    }

    // Reserve this invocation before any asynchronous operation. The guard
    // includes Redis reads, lock acquisition, marker writes and lock release
    // so overlapping ticks and shutdown drain checks see the same state.
    this.isRunning = true
    let phase = 'lock acquisition'
    try {
      const execute = async () => {
        // With a distributed lock this read and the completion write belong
        // to the same critical section. Another replica cannot act on a
        // stale pre-lock read after this worker publishes its marker.
        if (this.enableIdempotency && this.redisClient) {
          phase = 'idempotency read'
          const lastRun = await this.redisClient.get(this.idempotencyKeyBase)
          if (lastRun !== null) {
            this.logger('[Idempotency] Skipping job — completed within interval')
            return
          }
        }

        phase = 'job execution'
        // Generate a fresh correlation context for exactly one execution.
        await runWithCorrelationIds({ correlationId: randomUUID() }, () => this.job.run())

        if (this.enableIdempotency && this.redisClient) {
          phase = 'idempotency write'
          const acknowledgment = await this.redisClient.set(
            this.idempotencyKeyBase,
            new Date().toISOString(),
            { PX: this.intervalMs }
          )
          if (acknowledgment !== 'OK') {
            throw new Error('Completion marker was not acknowledged')
          }
        }
        // Results and raw dependency errors can contain credentials or user
        // data. Log the lifecycle and failing phase, not arbitrary payloads.
        this.logger('Job completed')
      }

      if (this.distributedLock) {
        const { executed } = await this.distributedLock.withLock(
          this.lockKey,
          execute,
          { ttlMs: this.lockTtlMs, logger: this.logger }
        )
        if (!executed) {
          this.logger(`Job skipped (lock held by another worker) — contentions: ${this.distributedLock.getMetrics().contentions}`)
        }
      } else {
        await execute()
      }
    } catch {
      // Fail closed when the guard cannot be read. A failed job never gets
      // a completion marker; the next tick can retry after recovery. If the
      // job completed but the marker write failed, retries are at-least-once:
      // callers must keep business side effects idempotent.
      this.logger(`Job failed during ${phase}; next interval may retry`)
    } finally {
      this.isRunning = false
    }
  }
}

/**
 * Parse cron expression to interval in milliseconds.
 * Simplified parser for common patterns.
 * 
 * Supported patterns:
 * - '0 * * * *' - Every hour (3600000ms)
 * - '0 0 * * *' - Every day (86400000ms)
 * - '* * * * *' - Every minute (60000ms)
 * 
 * @param cronExpression - Cron expression
 * @returns Interval in milliseconds
 */
export function parseCronToInterval(cronExpression: string): number {
  const parts = cronExpression.trim().split(/\s+/)
  
  if (parts.length !== 5) {
    throw new Error('Invalid cron expression: must have 5 parts')
  }

  const [minute, hour, day, month, weekday] = parts

  // This interval scheduler only supports the three documented patterns.
  // Silently ignoring calendar constraints would run jobs too frequently.
  if (day !== '*' || month !== '*' || weekday !== '*') {
    throw new Error(`Unsupported cron expression: ${cronExpression}`)
  }

  // Every minute
  if (minute === '*' && hour === '*') {
    return 60000
  }

  // Every hour
  if (minute === '0' && hour === '*') {
    return 3600000
  }

  // Every day
  if (minute === '0' && hour === '0') {
    return 86400000
  }

  throw new Error(`Unsupported cron expression: ${cronExpression}`)
}

/**
 * Create and start a scheduler for the score snapshot job.
 * 
 * @param job - Score snapshot job
 * @param options - Scheduler options
 * @returns JobScheduler instance
 */
export function createScheduler(
  job: SchedulableJob,
  options: SchedulerOptions = {}
): JobScheduler {
  const cronExpression = options.cronExpression ?? '0 * * * *'
  const intervalMs = parseCronToInterval(cronExpression)

  return new JobScheduler(job, {
    intervalMs,
    runOnStart: options.runOnStart,
    logger: options.logger,
    distributedLock: options.distributedLock,
    lockKey: options.lockKey,
    lockTtlMs: options.lockTtlMs,
    redisClient: options.redisClient,
    enableIdempotency: options.enableIdempotency,
  })
}

/**
 * Helper that returns a SQL string to select the next bulk job according to
 * a weighted-fair-queueing ordering which uses `org_usage_daily` to derive
 * per-org weights. This function is a convenience for bulk worker poll logic
 * and keeps the SQL localized so it can be reviewed and tested.
 *
 * NOTE: Integrators should validate table/column names to avoid SQL injection
 * when interpolating dynamic identifiers.
 */
export function getBulkWorkerPollQuery(jobsTable = 'bulk_jobs', orgUsageTable = 'org_usage_daily') {
  return `WITH org_w AS (
    SELECT org_id, 1.0 / (1 + COALESCE(usage, 0)) AS weight
    FROM ${orgUsageTable}
    WHERE day = CURRENT_DATE
  ), queued AS (
    SELECT j.*, COALESCE(w.weight, 1.0) AS weight
    FROM ${jobsTable} j
    LEFT JOIN org_w w ON j.org_id = w.org_id
    WHERE j.status = 'pending'
  ), scored AS (
    SELECT q.*,
      -- virtual score approximation: size divided by weight
      (q.size::float / q.weight) AS wfq_score
    FROM queued q
  )
  SELECT * FROM scored
  ORDER BY wfq_score ASC, created_at ASC
  LIMIT 1;`
}
