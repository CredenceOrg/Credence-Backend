import { pool } from '../pool.js'
import { OutboxRepository } from './repository.js'
import type { OutboxEvent, OutboxCleanupConfig } from './types.js'

/**
 * Event handler that processes published domain events.
 * Implement this to integrate with your event bus, webhook service, etc.
 */
export interface EventPublisher {
  publish(event: OutboxEvent): Promise<void>
}

export interface OutboxPublisherConfig {
  /** Polling interval in milliseconds. Default: 1000 */
  pollIntervalMs: number
  /** Batch size for fetching events. Default: 100 */
  batchSize: number
  /** Cleanup configuration. Default: 7 days for published, 30 for failed */
  cleanup: OutboxCleanupConfig
  /** Cleanup interval in milliseconds. Default: 3600000 (1 hour) */
  cleanupIntervalMs: number
}

const DEFAULT_CONFIG: OutboxPublisherConfig = {
  pollIntervalMs: 1000,
  batchSize: 100,
  cleanup: {
    publishedRetentionDays: 7,
    failedRetentionDays: 30,
  },
  cleanupIntervalMs: 3600000,
}

/**
 * Outbox publisher worker that polls for pending events and publishes them.
 * Handles retries, deduplication, and cleanup of old events.
 */
export class OutboxPublisher {
  private repository: OutboxRepository
  private publisher: EventPublisher
  private config: OutboxPublisherConfig
  private running: boolean = false
  private pollTimer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(publisher: EventPublisher, config?: Partial<OutboxPublisherConfig>) {
    this.repository = new OutboxRepository()
    this.publisher = publisher
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start the publisher worker.
   */
  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    console.log('[OutboxPublisher] Starting with config:', this.config)

    // Start polling loop
    this.pollTimer = setInterval(() => {
      this.processBatch().catch(err => {
        console.error('[OutboxPublisher] Error processing batch:', err)
      })
    }, this.config.pollIntervalMs)

    // Start cleanup loop
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch(err => {
        console.error('[OutboxPublisher] Error running cleanup:', err)
      })
    }, this.config.cleanupIntervalMs)

    // Process immediately on start
    await this.processBatch()
  }

  /**
   * Stop the publisher worker.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.running = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    console.log('[OutboxPublisher] Stopped')
  }

  /**
   * Process a batch of pending events.
   */
  private async processBatch(): Promise<void> {
    if (!this.running) {
      return
    }

    const events = await this.repository.fetchPendingForProcessing(pool, this.config.batchSize)

    if (events.length === 0) {
      return
    }

    console.log(`[OutboxPublisher] Processing ${events.length} events`)

    // Process events sequentially to maintain ordering per aggregate
    const aggregateGroups = this.groupByAggregate(events)

    for (const [aggregateKey, aggregateEvents] of aggregateGroups) {
      await this.processAggregateEvents(aggregateKey, aggregateEvents)
    }
  }

  /**
   * Group events by aggregate to maintain ordering guarantees.
   */
  private groupByAggregate(events: OutboxEvent[]): Map<string, OutboxEvent[]> {
    const groups = new Map<string, OutboxEvent[]>()

    for (const event of events) {
      const key = `${event.aggregateType}:${event.aggregateId}`
      const group = groups.get(key) ?? []
      group.push(event)
      groups.set(key, group)
    }

    return groups
  }

  /**
   * Process events for a single aggregate sequentially to maintain ordering.
   */
  private async processAggregateEvents(aggregateKey: string, events: OutboxEvent[]): Promise<void> {
    for (const event of events) {
      await this.processEvent(event)
    }
  }

  /**
   * Process a single event with error handling and retry logic.
   */
  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      await this.publisher.publish(event)
      await this.repository.markPublished(pool, event.id)
      console.log(`[OutboxPublisher] Published event ${event.id} (${event.eventType})`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(
        `[OutboxPublisher] Failed to publish event ${event.id} (${event.eventType}):`,
        errorMessage
      )
      await this.repository.markFailed(pool, event.id, errorMessage)
    }
  }

  /**
   * Run cleanup of old events based on retention policy.
   */
  private async runCleanup(): Promise<void> {
    try {
      const deletedCount = await this.repository.cleanup(pool, this.config.cleanup)
      if (deletedCount > 0) {
        console.log(`[OutboxPublisher] Cleaned up ${deletedCount} old events`)
      }
    } catch (error) {
      console.error('[OutboxPublisher] Cleanup error:', error)
    }
  }

  /**
   * Get current statistics about the outbox.
   */
  async getStats(): Promise<{
    pending: number
    processing: number
    published: number
    failed: number
  }> {
    return this.repository.getStats(pool)
  }
}
