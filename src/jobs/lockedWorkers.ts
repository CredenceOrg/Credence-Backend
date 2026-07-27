import type { DistributedLock } from './distributedLock.js'
import type { RedisClient } from '../cache/redis.js'
import type { IdempotencyRedisClient } from './scheduler.js'
import { InvoiceDueDateWorker, type InvoiceDueDateWorkerOptions, type InvoiceDueDateWorkerResult } from './invoiceDueDateWorker.js'
import { ExportWorker, type ExportWorkerOptions, type ExportWorkerResult } from './exportWorker.js'
import { AnalyticsRefreshWorker, type AnalyticsRefreshWorkerResult } from './analyticsRefreshWorker.js'

/**
 * Base interface for locked worker options
 */
export interface BaseLockedWorkerOptions {
  /** Distributed lock instance for preventing duplicate execution */
  distributedLock: DistributedLock
  /** Redis key used as the lock name */
  lockKey: string
  /** Lock TTL in milliseconds (default: 30 minutes) */
  lockTtlMs?: number
  /** Logger function for lock lifecycle events */
  logger?: (message: string) => void
  /** Redis client for idempotency checks. When set together with enableIdempotency,
   *  the worker skips execution if a lastRun marker already exists. */
  redisClient?: IdempotencyRedisClient
  /** Enable idempotency guard using Redis lastRun markers. */
  enableIdempotency?: boolean
}

/**
 * Options for locked invoice due date worker
 */
export interface LockedInvoiceDueDateWorkerOptions extends InvoiceDueDateWorkerOptions, BaseLockedWorkerOptions {}

/**
 * Options for locked export worker
 */
export interface LockedExportWorkerOptions extends ExportWorkerOptions, BaseLockedWorkerOptions {}

/**
 * Options for locked analytics refresh worker
 */
export interface LockedAnalyticsRefreshWorkerOptions extends BaseLockedWorkerOptions {
  /** Analytics service instance */
  analyticsService: any
}

/**
 * Invoice due date worker with distributed lock support
 * Prevents concurrent execution across scaled worker replicas
 */
export class LockedInvoiceDueDateWorker {
  private readonly lockTtlMs: number
  private readonly logger: (message: string) => void
  private readonly redisClient?: IdempotencyRedisClient
  private readonly enableIdempotency: boolean
  private readonly idempotencyKey: string

  constructor(
    private readonly worker: InvoiceDueDateWorker,
    private readonly distributedLock: DistributedLock,
    private readonly lockKey: string,
    options: Omit<LockedInvoiceDueDateWorkerOptions, 'distributedLock' | 'lockKey'> = {}
  ) {
    this.lockTtlMs = options.lockTtlMs ?? 30 * 60 * 1000 // 30 minutes
    this.logger = options.logger ?? (() => {})
    this.redisClient = options.redisClient
    this.enableIdempotency = options.enableIdempotency ?? false
    this.idempotencyKey = `${this.lockKey}:lastRun`
  }

  /**
   * Run the worker with distributed lock protection
   * 
   * @param nowUtc - Current time in UTC (optional, defaults to now)
   * @returns Worker execution result or null if lock was not acquired
   */
  async run(nowUtc?: Date | string): Promise<InvoiceDueDateWorkerResult | null> {
    // Idempotency guard: skip if job was recently completed
    if (this.enableIdempotency && this.redisClient) {
      const lastRun = await this.redisClient.get(this.idempotencyKey)
      if (lastRun) {
        this.logger(`[LockedInvoiceDueDateWorker] Skipped due date evaluation (idempotency — last run at ${lastRun})`)
        return null
      }
    }

    const { executed, result } = await this.distributedLock.withLock(
      this.lockKey,
      async () => {
        this.logger(`[LockedInvoiceDueDateWorker] Starting due date evaluation`)
        const workerResult = await this.worker.run(nowUtc)

        // Set idempotency marker after successful execution
        if (this.enableIdempotency && this.redisClient) {
          await this.redisClient.set(
            this.idempotencyKey,
            new Date().toISOString(),
            { PX: this.lockTtlMs }
          )
        }

        return workerResult
      },
      { 
        ttlMs: this.lockTtlMs, 
        logger: (msg) => this.logger(`[LockedInvoiceDueDateWorker] ${msg}`) 
      }
    )

    if (!executed) {
      this.logger(`[LockedInvoiceDueDateWorker] Skipped due date evaluation (lock held by another worker)`)
      return null
    }

    return result!
  }

  /**
   * Get distributed lock metrics
   */
  getLockMetrics() {
    return this.distributedLock.getMetrics()
  }
}

/**
 * Export worker with distributed lock support
 * Prevents concurrent execution across scaled worker replicas
 */
export class LockedExportWorker {
  private readonly lockTtlMs: number
  private readonly logger: (message: string) => void
  private readonly redisClient?: IdempotencyRedisClient
  private readonly enableIdempotency: boolean
  private readonly idempotencyKey: string

  constructor(
    private readonly worker: ExportWorker,
    private readonly distributedLock: DistributedLock,
    private readonly lockKey: string,
    options: Omit<LockedExportWorkerOptions, 'distributedLock' | 'lockKey'> = {}
  ) {
    this.lockTtlMs = options.lockTtlMs ?? 60 * 60 * 1000 // 1 hour for exports
    this.logger = options.logger ?? (() => {})
    this.redisClient = options.redisClient
    this.enableIdempotency = options.enableIdempotency ?? false
    this.idempotencyKey = `${this.lockKey}:lastRun`
  }

  /**
   * Run the export worker with distributed lock protection
   * 
   * @returns Export execution result or null if lock was not acquired
   */
  async run(): Promise<ExportWorkerResult | null> {
    // Idempotency guard: skip if job was recently completed
    if (this.enableIdempotency && this.redisClient) {
      const lastRun = await this.redisClient.get(this.idempotencyKey)
      if (lastRun) {
        this.logger(`[LockedExportWorker] Skipped export (idempotency — last run at ${lastRun})`)
        return null
      }
    }

    const { executed, result } = await this.distributedLock.withLock(
      this.lockKey,
      async () => {
        this.logger(`[LockedExportWorker] Starting data export`)
        const workerResult = await this.worker.run()

        // Set idempotency marker after successful execution
        if (this.enableIdempotency && this.redisClient) {
          await this.redisClient.set(
            this.idempotencyKey,
            new Date().toISOString(),
            { PX: this.lockTtlMs }
          )
        }

        return workerResult
      },
      { 
        ttlMs: this.lockTtlMs, 
        logger: (msg) => this.logger(`[LockedExportWorker] ${msg}`) 
      }
    )

    if (!executed) {
      this.logger(`[LockedExportWorker] Skipped export (lock held by another worker)`)
      return null
    }

    return result!
  }

  /**
   * Get distributed lock metrics
   */
  getLockMetrics() {
    return this.distributedLock.getMetrics()
  }
}

/**
 * Analytics refresh worker with distributed lock support
 * Prevents concurrent execution across scaled worker replicas
 */
export class LockedAnalyticsRefreshWorker {
  private readonly lockTtlMs: number
  private readonly logger: (message: string) => void
  private readonly redisClient?: IdempotencyRedisClient
  private readonly enableIdempotency: boolean
  private readonly idempotencyKey: string

  constructor(
    private readonly worker: AnalyticsRefreshWorker,
    private readonly distributedLock: DistributedLock,
    private readonly lockKey: string,
    options: Omit<LockedAnalyticsRefreshWorkerOptions, 'distributedLock' | 'lockKey' | 'analyticsService'> = {}
  ) {
    this.lockTtlMs = options.lockTtlMs ?? 15 * 60 * 1000 // 15 minutes for analytics refresh
    this.logger = options.logger ?? (() => {})
    this.redisClient = options.redisClient
    this.enableIdempotency = options.enableIdempotency ?? false
    this.idempotencyKey = `${this.lockKey}:lastRun`
  }

  /**
   * Run the analytics refresh worker with distributed lock protection
   * 
   * @returns Refresh execution result or null if lock was not acquired
   */
  async run(): Promise<AnalyticsRefreshWorkerResult | null> {
    // Idempotency guard: skip if job was recently completed
    if (this.enableIdempotency && this.redisClient) {
      const lastRun = await this.redisClient.get(this.idempotencyKey)
      if (lastRun) {
        this.logger(`[LockedAnalyticsRefreshWorker] Skipped analytics refresh (idempotency — last run at ${lastRun})`)
        return null
      }
    }

    const { executed, result } = await this.distributedLock.withLock(
      this.lockKey,
      async () => {
        this.logger(`[LockedAnalyticsRefreshWorker] Starting analytics refresh`)
        const workerResult = await this.worker.run()

        // Set idempotency marker after successful execution
        if (this.enableIdempotency && this.redisClient) {
          await this.redisClient.set(
            this.idempotencyKey,
            new Date().toISOString(),
            { PX: this.lockTtlMs }
          )
        }

        return workerResult
      },
      { 
        ttlMs: this.lockTtlMs, 
        logger: (msg) => this.logger(`[LockedAnalyticsRefreshWorker] ${msg}`) 
      }
    )

    if (!executed) {
      this.logger(`[LockedAnalyticsRefreshWorker] Skipped analytics refresh (lock held by another worker)`)
      return null
    }

    return result!
  }

  /**
   * Get distributed lock metrics
   */
  getLockMetrics() {
    return this.distributedLock.getMetrics()
  }
}

/**
 * Factory functions for creating locked workers
 */

export function createLockedInvoiceDueDateWorker(
  worker: InvoiceDueDateWorker,
  distributedLock: DistributedLock,
  lockKey: string,
  options?: Omit<LockedInvoiceDueDateWorkerOptions, 'distributedLock' | 'lockKey'>
): LockedInvoiceDueDateWorker {
  return new LockedInvoiceDueDateWorker(worker, distributedLock, lockKey, options)
}

export function createLockedExportWorker(
  worker: ExportWorker,
  distributedLock: DistributedLock,
  lockKey: string,
  options?: Omit<LockedExportWorkerOptions, 'distributedLock' | 'lockKey'>
): LockedExportWorker {
  return new LockedExportWorker(worker, distributedLock, lockKey, options)
}

export function createLockedAnalyticsRefreshWorker(
  worker: AnalyticsRefreshWorker,
  distributedLock: DistributedLock,
  lockKey: string,
  options?: Omit<LockedAnalyticsRefreshWorkerOptions, 'distributedLock' | 'lockKey' | 'analyticsService'>
): LockedAnalyticsRefreshWorker {
  return new LockedAnalyticsRefreshWorker(worker, distributedLock, lockKey, options)
}
