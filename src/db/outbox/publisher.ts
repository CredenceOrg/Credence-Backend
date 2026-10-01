import { pool } from '../pool.js'
import { OutboxRepository } from './repository.js'
import type { OutboxEvent, OutboxCleanupConfig, OutboxQuarantineReason } from './types.js'
import { randomUUID } from 'crypto'
import type { ZodType } from 'zod'
import {
  recordOutboxPublisherHeartbeat,
  setOutboxPublisherRunning,
} from '../../services/health/runtimeState.js'
import {
  attestationEventSchema,
  bondCreationEventSchema,
  withdrawalEventSchema,
} from '../../schemas/queue.js'
import { logger, runWithCorrelationIds } from '../../utils/logger.js'
import {
  incrementOutboxDeadLetter,
  incrementOutboxPublished,
  incrementOutboxFailed,
  setOutboxPendingGauge,
  setOutboxLifecycleGauges,
  incrementOutboxLeaseRenew,
  incrementOutboxQuarantine,
} from '../../observability/index.js'
import {
  recordJobDeadLetter,
  recordJobTerminalOutcome,
} from '../../jobs/retryMetrics.js'
import { trace, context, SpanContext, TraceFlags, SpanStatusCode, createTraceState } from '@opentelemetry/api'

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
  /** Unique consumer identifier. Auto-generated if not provided. */
  consumerId?: string
  /** Lease duration in seconds. Default: 300 (5 minutes) */
  leaseSeconds?: number
  /** Heartbeat interval in milliseconds. Default: leaseSeconds * 1000 / 2 */
  heartbeatIntervalMs?: number
  /** Metrics scrape interval in milliseconds. Default: 15000 */
  metricsIntervalMs?: number
  /** Maximum serialized payload size accepted by the publisher. Default: 262144 (256 KiB) */
  maxPayloadBytes?: number
  /** Number of shards for horizontal scaling */
  shardCount?: number
  /** Shard ID assigned to this publisher instance */
  shardId?: number
}

const DEFAULT_CONFIG: OutboxPublisherConfig = {
  pollIntervalMs: 1000,
  batchSize: 100,
  cleanup: {
    publishedRetentionDays: 7,
    failedRetentionDays: 30,
  },
  cleanupIntervalMs: 3600000,
  metricsIntervalMs: 15000,
  maxPayloadBytes: 262144,
}

const QUEUE_EVENT_SCHEMAS: Record<string, ZodType> = {
  'attestation.event': attestationEventSchema,
  'attestation.add': attestationEventSchema,
  'attestation.revoke': attestationEventSchema,
  'bond.creation': bondCreationEventSchema,
  'bond.create': bondCreationEventSchema,
  'withdrawal.event': withdrawalEventSchema,
  'bond.withdrawal': withdrawalEventSchema,
}

/** Build a deterministic idempotency key from the consumer and event IDs. */
function buildPublishIdempotencyKey(consumerId: string, eventId: bigint): string {
  return `outbox-pub:${consumerId}:${eventId}`
}

const KNOWN_OUTBOX_EVENT_TYPES = new Set([
  'bond.created',
  'bond.slashed',
  'bond.withdrawn',
  'attestation.created',
  'attestation.revoked',
  ...Object.keys(QUEUE_EVENT_SCHEMAS),
])

interface PoisonPillDetection {
  reason: OutboxQuarantineReason
  message: string
}

/**
 * Outbox publisher worker that polls for pending events and publishes them.
 * Handles retries, deduplication, and cleanup of old events.
 * Supports crash-safe recovery via consumer leases and idempotent consumer keys.
 */
export class OutboxPublisher {
  private repository: OutboxRepository
  private publisher: EventPublisher
  private config: OutboxPublisherConfig
  private running: boolean = false
  private pollTimer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private metricsTimer: NodeJS.Timeout | null = null
  private consumerId: string
  private leaseSeconds: number
  private heartbeatIntervalMs: number

  constructor(publisher: EventPublisher, config?: Partial<OutboxPublisherConfig>) {
    if (config?.shardCount !== undefined || config?.shardId !== undefined) {
      const count = config?.shardCount
      const id = config?.shardId
      if (count === undefined || id === undefined) {
        throw new Error('Both shardCount and shardId must be provided if either is set')
      }
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error('shardCount must be a positive integer')
      }
      if (!Number.isInteger(id) || id < 0 || id >= count) {
        throw new Error('shardId must be a non-negative integer less than shardCount')
      }
    }

    this.repository = new OutboxRepository()
    this.publisher = publisher
    this.consumerId = config?.consumerId ?? randomUUID()
    this.leaseSeconds = config?.leaseSeconds ?? 300
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? (this.leaseSeconds * 1000) / 2
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
    setOutboxPublisherRunning(true)
    recordOutboxPublisherHeartbeat()
    logger.info({
      message: '[OutboxPublisher] Starting',
      config: {
        ...this.config,
        consumerId: this.consumerId,
        leaseSeconds: this.leaseSeconds,
      }
    })

    // Start heartbeat loop to renew leases
    this.heartbeatTimer = setInterval(() => {
      this.renewLease().catch(err => {
        logger.error('[OutboxPublisher] Lease renewal error', err)
      })
    }, this.heartbeatIntervalMs)

    // Start polling loop
    this.pollTimer = setInterval(() => {
      this.processBatch().catch(err => {
        logger.error('[OutboxPublisher] Error processing batch', err)
      })
    }, this.config.pollIntervalMs)

    // Start cleanup loop
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch(err => {
        logger.error('[OutboxPublisher] Error running cleanup', err)
      })
    }, this.config.cleanupIntervalMs)

    // Start metrics scrape loop
    this.metricsTimer = setInterval(() => {
      this.scrapeMetrics().catch(err => {
        logger.error('[OutboxPublisher] Error scraping metrics', err)
      })
    }, this.config.metricsIntervalMs)

    // Process immediately on start
    await this.processBatch()
    await this.scrapeMetrics()
  }

  /**
   * Stop the publisher worker.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.running = false
    setOutboxPublisherRunning(false)

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
      // Reset gauge when stopping to avoid stale metrics
      setOutboxPendingGauge(0)
    }

    // Release any claims to allow other consumers to pick up quickly
    await this.repository.releaseClaims(pool, this.consumerId)

    logger.info('[OutboxPublisher] Stopped')
  }

  /**
   * Renew the lease on currently claimed events.
   */
  private async renewLease(): Promise<void> {
    if (!this.running) {
      return
    }
    const renewed = await this.repository.renewLease(pool, this.consumerId, this.leaseSeconds)
    recordOutboxPublisherHeartbeat()
    if (renewed > 0) {
      incrementOutboxLeaseRenew(renewed)
      logger.debug(`[OutboxPublisher] Renewed lease for ${renewed} events`)
    }
  }

  /**
   * Process a batch of pending events.
   */
  private async processBatch(): Promise<void> {
    if (!this.running) {
      return
    }

    const events = await this.repository.claimEvents(
      pool,
      this.consumerId,
      this.config.batchSize,
      this.leaseSeconds,
      this.config.shardCount,
      this.config.shardId
    )

    if (events.length === 0) {
      recordOutboxPublisherHeartbeat()
      return
    }

    logger.info(`[OutboxPublisher] Processing ${events.length} events`)

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
   * Uses a publish idempotency key to prevent duplicate emissions if the
   * worker crashes mid-batch after publish but before markPublished.
   */
  private async processEvent(event: OutboxEvent): Promise<void> {
    const poison = this.detectPoisonPill(event)
    if (poison) {
      await this.quarantineEvent(event, poison.reason, poison.message)
      return
    }

    // Idempotency guard: if this event was already published by a previous
    // (crashed) consumer, skip publish and go straight to markPublished.
    if (event.publishIdempotencyKey) {
      logger.info(`[OutboxPublisher] Event ${event.id} already has publish idempotency key — skipping publish`)
      await this.repository.markPublished(pool, event.id, this.consumerId)
      incrementOutboxPublished(event.aggregateType)
      return
    }

    // Atomically set the idempotency key BEFORE publishing.  If another
    // consumer already set it (extremely rare race), treat as duplicate.
    const key = buildPublishIdempotencyKey(this.consumerId, event.id)
    const acquired = await this.repository.trySetPublishIdempotencyKey(pool, event.id, key, this.consumerId)
    if (!acquired) {
      logger.info(`[OutboxPublisher] Event ${event.id} publish idempotency key already set — skipping publish`)
      await this.repository.markPublished(pool, event.id, this.consumerId)
      incrementOutboxPublished(event.aggregateType)
      return
    }

    // Create parent span context from stored trace data if available
    let parentSpanContext: SpanContext | undefined
    if (event.traceId && event.spanId) {
      parentSpanContext = {
        traceId: event.traceId,
        spanId: event.spanId,
        traceFlags: TraceFlags.SAMPLED,
      }
      if (event.tracestate) {
        parentSpanContext.traceState = createTraceState(event.tracestate)
      }
    }

    const tracer = trace.getTracer('outbox-publisher')
    const links = parentSpanContext ? [{ context: parentSpanContext }] : []

    try {
      await tracer.startActiveSpan('outbox.publish', { links, attributes: { 'outbox.event.id': event.id.toString(), 'outbox.event.type': event.eventType, 'outbox.aggregate.type': event.aggregateType, 'outbox.aggregate.id': event.aggregateId } }, async (span) => {
        try {
          // Restore the correlation id captured at emit time so any logger
          // calls made while publishing (including inside the webhook
          // delivery HTTP client) are tagged with the id of the request
          // that originally triggered this event.
          const publish = () => this.publisher.publish(event)
          const withCorrelation = event.correlationId
            ? runWithCorrelationIds({ correlationId: event.correlationId }, publish)
            : publish()

          await withCorrelation

          await this.repository.markPublished(pool, event.id, this.consumerId)
          incrementOutboxPublished(event.aggregateType)
          recordJobTerminalOutcome('outbox', 'success')
          span.setStatus({ code: SpanStatusCode.OK })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          span.recordException(error as Error)
          span.setStatus({ code: SpanStatusCode.ERROR, message })
          await this.handlePublishFailure(event, message)
        } finally {
          span.end()
        }
      })
    } catch (error) {
      // If the tracer itself throws before the inner handler runs, fall back
      // to the same failure handling path so the event is not lost.
      const message = error instanceof Error ? error.message : String(error)
      await this.handlePublishFailure(event, message)
    }
  }

  /**
   * Handle a publish failure by either scheduling a retry or moving the
   * event to the dead-letter state once retries are exhausted.
   */
  private async handlePublishFailure(event: OutboxEvent, message: string): Promise<void> {
    const nextRetry = event.retryCount + 1
    if (nextRetry >= event.maxRetries) {
      await this.repository.markFailed(pool, event.id, message, true)
      incrementOutboxDeadLetter(event.aggregateType)
      recordJobDeadLetter('outbox')
      recordJobTerminalOutcome('outbox', 'dead_letter')
      logger.error(`[OutboxPublisher] Event ${event.id} exhausted retries — moved to dead letter`)
    } else {
      await this.repository.markFailed(pool, event.id, message, false)
      incrementOutboxFailed(event.aggregateType)
      recordJobTerminalOutcome('outbox', 'retry')
      logger.warn(`[OutboxPublisher] Event ${event.id} failed (attempt ${nextRetry}/${event.maxRetries}): ${message}`)
    }
  }

  /**
   * Detect whether an event is a poison pill that should be quarantined
   * instead of retried indefinitely.
   */
  private detectPoisonPill(event: OutboxEvent): PoisonPillDetection | null {
    if (event.payloadParseError) {
      return { reason: 'malformed_json', message: event.payloadParseError }
    }

    const maxBytes = this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes!
    if (typeof event.rawPayload === 'string' && Buffer.byteLength(event.rawPayload) > maxBytes) {
      return {
        reason: 'oversized_payload',
        message: `payload exceeds ${maxBytes} bytes`,
      }
    }

    if (!KNOWN_OUTBOX_EVENT_TYPES.has(event.eventType)) {
      return {
        reason: 'unknown_event_type',
        message: `unknown event type ${event.eventType}`,
      }
    }

    const schema = QUEUE_EVENT_SCHEMAS[event.eventType]
    if (schema) {
      const result = schema.safeParse(event.payload)
      if (!result.success) {
        return {
          reason: 'schema_invalid',
          message: result.error.issues.map(i => `${i.path}.join('.')}: ${i.message}`).join('; '),
        }
      }
    }

    return null
  }

  /**
   * Quarantine an event that cannot be published.
   */
  private async quarantineEvent(event: OutboxEvent, reason: OutboxQuarantineReason, message: string): Promise<void> {
    await this.repository.quarantine(pool, event, reason, message)
    incrementOutboxQuarantine(reason)
    logger.warn(`[OutboxPublisher] Quarantined event ${event.id} (${reason}): ${message}`)
  }

  /**
   * Run cleanup of old events.
   */
  private async runCleanup(): Promise<void> {
    if (!this.running) {
      return
    }

    try {
      const deleted = await this.repository.cleanup(pool, this.config.cleanup)
      if (deleted > 0) {
        logger.info(`[OutboxPublisher] Cleaned up ${deleted} old events`)
      }
    } catch (error) {
      logger.error('[OutboxPublisher] Cleanup failed', error)
    }
  }

  /**
   * Scrape metrics for monitoring.
   */
  private async scrapeMetrics(): Promise<void> {
    if (!this.running) {
      return
    }

    try {
      const metrics = await this.repository.getMetrics(pool)
      setOutboxPendingGauge(metrics.pending)
      setOutboxLifecycleGauges({
        pending: metrics.pending,
        processing: metrics.processing,
        published: metrics.published,
        failed: metrics.failed,
        deadLetter: metrics.deadLetter,
      })
    } catch (error) {
      logger.error('[OutboxPublisher] Metrics scrape failed', error)
    }
  }
}
