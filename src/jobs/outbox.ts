import { OutboxPublisher } from '../db/outbox/publisher.js'
import type { OutboxPublisherConfig } from '../db/outbox/publisher.js'
import { WebhookEventPublisher } from '../db/outbox/webhookPublisher.js'
import { PostgresWebhookRepository } from '../db/repositories/webhookRepository.js'
import { PostgresDlqStore } from '../services/webhooks/postgresDlqStore.js'
import { auditLogService } from '../services/audit/index.js'
import { WebhookService } from '../services/webhooks/service.js'
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
}

/**
 * Background job that runs the OutboxPublisher.
 * Manages lifecycle (start/stop) and holds dependencies.
 */
export class OutboxJob {
  private publisher: OutboxPublisher | null = null

  constructor(
    private readonly pool: Pool,
    private readonly options: OutboxJobOptions = {}
  ) {}

  /**
   * Start the outbox publisher.
   */
  async start(): Promise<void> {
    // Create dependencies
    const webhookStore = new PostgresWebhookRepository(this.pool)
    const dlqStore = new PostgresDlqStore(this.pool)
    const webhookService = new WebhookService(webhookStore, undefined, dlqStore, auditLogService)
    const eventPublisher = new WebhookEventPublisher(webhookService)

    // Build configuration
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

  /**
   * Stop the outbox publisher gracefully.
   */
  async stop(): Promise<void> {
    await this.publisher?.stop()
  }
}
