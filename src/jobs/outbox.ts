import { OutboxPublisher } from '../db/outbox/publisher.js'
import type { OutboxPublisherConfig } from '../db/outbox/publisher.js'
import { WebhookEventPublisher } from '../db/outbox/webhookPublisher.js'
import { PostgresWebhookRepository } from '../db/repositories/webhookRepository.js'
import { PostgresDlqStore } from '../services/webhooks/postgresDlqStore.js'
import { auditLogService } from '../services/audit/index.js'
import { WebhookService } from '../services/webhooks/service.js'
import { WorkerLeaseManager } from './workerLeaseManager.js'
import {
  incrementOutboxLeaderAcquired,
  incrementOutboxLeaderLost,
} from '../observability/index.js'
import type { Pool } from 'pg'

export interface OutboxJobOptions {
  pollIntervalMs?: number
  batchSize?: number
  publishedRetentionDays?: number
  failedRetentionDays?: number
  cleanupIntervalMs?: number
  consumerId?: string
  leaseSeconds?: number
  heartbeatIntervalMs?: number
  leaderLease?: {
    enabled?: boolean
    retryIntervalMs?: number
    heartbeatIntervalMs?: number
  }
}

/**
 * Background job that runs the OutboxPublisher.
 * Manages lifecycle (start/stop) and holds dependencies.
 *
 * When `leaderLease.enabled` is true, the job uses a Postgres advisory lock
 * to ensure only one instance runs the outbox loop at a time.
 */
export class OutboxJob {
  private publisher: OutboxPublisher | null = null
  private leaseManager: WorkerLeaseManager | null = null
  private started = false

  constructor(
    private readonly pool: Pool,
    private readonly options: OutboxJobOptions = {}
  ) {}

  /**
   * Start the outbox publisher.
   *
   * When the leader lease is enabled the publisher is only started after
   * this instance acquires advisory-lock leadership.  If leadership is
   * lost the publisher is stopped and the instance re-enters standby mode.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    if (this.options.leaderLease?.enabled) {
      this.leaseManager = new WorkerLeaseManager({
        pool: this.pool,
        retryIntervalMs: this.options.leaderLease.retryIntervalMs,
        heartbeatIntervalMs: this.options.leaderLease.heartbeatIntervalMs,
      })

      this.leaseManager.on({
        onStateChange: async (state) => {
          if (state === 'leader') {
            incrementOutboxLeaderAcquired()
            await this.startPublisher()
          } else {
            await this.stopPublisher()
          }
        },
        onReleased: () => {
          incrementOutboxLeaderLost()
        },
      })

      await this.leaseManager.start()
      return
    }

    // No leader lease — start publisher immediately (backwards-compatible)
    await this.startPublisher()
  }

  /**
   * Stop the outbox publisher gracefully.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    await this.stopPublisher()

    if (this.leaseManager) {
      await this.leaseManager.stop()
      this.leaseManager = null
    }
  }

  /** Whether the outbox loop is currently active (leader holds the lock). */
  isRunning(): boolean {
    return this.publisher !== null
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async startPublisher(): Promise<void> {
    if (this.publisher) return

    const webhookStore = new PostgresWebhookRepository(this.pool)
    const dlqStore = new PostgresDlqStore(this.pool)
    const webhookService = new WebhookService(webhookStore, undefined, dlqStore, auditLogService)
    const eventPublisher = new WebhookEventPublisher(webhookService)

    const config: OutboxPublisherConfig = {
      pollIntervalMs: this.options.pollIntervalMs ?? 1000,
      batchSize: this.options.batchSize ?? 100,
      cleanup: {
        publishedRetentionDays: this.options.publishedRetentionDays ?? 7,
        failedRetentionDays: this.options.failedRetentionDays ?? 30,
      },
      cleanupIntervalMs: this.options.cleanupIntervalMs ?? 3600000,
      consumerId: this.options.consumerId,
      leaseSeconds: this.options.leaseSeconds ?? 300,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
    }

    this.publisher = new OutboxPublisher(eventPublisher, config)
    await this.publisher.start()
  }

  private async stopPublisher(): Promise<void> {
    if (!this.publisher) return
    await this.publisher.stop()
    this.publisher = null
  }
}
