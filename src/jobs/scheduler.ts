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

    if (this.runOnStart) {
      this.runJob()
    }

    this.intervalId = setInterval(() => {
      this.runJob()
    }, this.intervalMs)
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

    // Scheduled jobs have no originating HTTP request, so there is no
    // correlation id to inherit. Generate one per run so that any outbox
    // events or webhook deliveries triggered by this job's business logic
    // (via the shared tracing context) can still be traced back to the
    // specific run that caused them.
    const jobRunCorrelationId = randomUUID()
    // Idempotency guard: check if job was recently completed
    if (this.enableIdempotency && this.redisClient) {
      const lastRun = await this.redisClient.get(this.idempotencyKeyBase)
      if (lastRun) {
        this.logger(
          `[Idempotency] Skipping job "${this.lockKey}" — last run at ${lastRun} (within interval)`
        )
        return
      }
    }

    if (this.distributedLock) {
      const { executed, result } = await this.distributedLock.withLock(
        this.lockKey,
        async () => {
          this.isRunning = true
          try {
            const result = await runWithCorrelationIds(
              { correlationId: jobRunCorrelationId },
              () => this.job.run()
            )
            this.logger(`Job completed: ${JSON.stringify(result)}`)
            const jobResult = await this.job.run()
            this.logger(`Job completed: ${JSON.stringify(jobResult)}`)
            return jobResult
          } finally {
            this.isRunning = false
          }
        },
        { ttlMs: this.lockTtlMs, logger: this.logger }
      )

      if (!executed) {
        const metrics = this.distributedLock.getMetrics()
        this.logger(
          `Job skipped (lock held by another worker) — contentions: ${metrics.contentions}`
        )
        return
      }

      // Set idempotency marker after successful execution
      if (this.enableIdempotency && this.redisClient) {
        await this.redisClient.set(
          this.idempotencyKeyBase,
          new Date().toISOString(),
          { PX: this.intervalMs }
        )
      }
      return
    }

    this.isRunning = true
    try {
      const result = await runWithCorrelationIds(
        { correlationId: jobRunCorrelationId },
        () => this.job.run()
      )
      this.logger(`Job completed: ${JSON.stringify(result)}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      this.logger(`Job failed: ${errorMsg}`)
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
  const parts = cronExpression.split(' ')
  
  if (parts.length !== 5) {
    throw new Error('Invalid cron expression: must have 5 parts')
  }

  const [minute, hour] = parts

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
