import type { ScoreSnapshotJob, SnapshotJobResult } from './scoreSnapshot.js'

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
  private intervalId: NodeJS.Timeout | null = null
  private isRunning = false
  private readonly intervalMs: number
  private readonly runOnStart: boolean
  private readonly logger: (message: string) => void

  constructor(
    private readonly job: ScoreSnapshotJob,
    options: { intervalMs: number; runOnStart?: boolean; logger?: (message: string) => void }
  ) {
    this.intervalMs = options.intervalMs
    this.runOnStart = options.runOnStart ?? false
    this.logger = options.logger ?? (() => {})
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
   * Run the job (internal).
   */
  private async runJob(): Promise<void> {
    if (this.isRunning) {
      this.logger('Job already running, skipping this interval')
      return
    }

    this.isRunning = true

    try {
      const result = await this.job.run()
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

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

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
  job: ScoreSnapshotJob,
  options: SchedulerOptions = {}
): JobScheduler {
  const cronExpression = options.cronExpression ?? '0 * * * *'
  const intervalMs = parseCronToInterval(cronExpression)

  return new JobScheduler(job, {
    intervalMs,
    runOnStart: options.runOnStart,
    logger: options.logger,
  })
}
