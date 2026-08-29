import type { Queryable } from '../repositories/queryable.js'
import { OutboxRepository } from './repository.js'
import type { CreateOutboxEvent } from './types.js'
import { trace } from '@opentelemetry/api'
import { getActiveCorrelationIds } from '../../utils/logger.js'

/**
 * Helper for emitting domain events to the outbox within a transaction.
 * Use this instead of directly publishing events to ensure atomicity.
 */
export class OutboxEventEmitter {
  constructor(private readonly repository: OutboxRepository = new OutboxRepository()) {}

  /**
   * Emit a domain event to the outbox within the provided transaction.
   * The event will be published asynchronously by the OutboxPublisher worker.
   *
   * @param db - Database connection or transaction client
   * @param event - Event to emit
   * @returns The ID of the created outbox event
   */
  async emit(db: Queryable, event: CreateOutboxEvent): Promise<bigint> {
    const spanContext = trace.getActiveSpan()?.spanContext()
    const { correlationId } = getActiveCorrelationIds()
    const eventWithTrace: CreateOutboxEvent = {
      ...event,
      version: event.version ?? 1,
      tenantId,
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      tracestate: spanContext?.traceState?.serialize(),
      correlationId: event.correlationId ?? correlationId,
    }
    return this.repository.create(db, eventWithTrace)
  }

  /**
   * Emit multiple events in a single transaction.
   * Useful for emitting related events atomically.
   */
  async emitBatch(db: Queryable, events: CreateOutboxEvent[]): Promise<bigint[]> {
    const ids = []
    const spanContext = trace.getActiveSpan()?.spanContext()
    const { correlationId } = getActiveCorrelationIds()
    for (const event of events) {
      const eventWithTrace: CreateOutboxEvent = {
        ...event,
        version: event.version ?? 1,
        tenantId,
        traceId: spanContext?.traceId,
        spanId: spanContext?.spanId,
        tracestate: spanContext?.traceState?.serialize(),
        correlationId: event.correlationId ?? correlationId,
      }
      const id = await this.repository.create(db, eventWithTrace)
      ids.push(id)
    }
    return ids
  }
}

/**
 * Singleton instance for convenience.
 */
export const outboxEmitter = new OutboxEventEmitter()
