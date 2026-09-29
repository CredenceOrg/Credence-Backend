import type { Queryable } from '../repositories/queryable.js'
import { OutboxRepository } from './repository.js'
import type { CreateOutboxEvent } from './types.js'
import { trace } from '@opentelemetry/api'
import { getActiveCorrelationIds } from '../../utils/logger.js'

/**
 * Maximum number of events accepted by a single {@link OutboxEventEmitter.emitBatch} call.
 *
 * This is a defensive bound so a bugy caller cannot accidentally enqueue an unbounded number of
 * events inside a single transaction and exhaust memory or locks. The value is deliberately
 * generous but finite.
 */
export const MAX_BATCH_SIZE = 1000

/**
 * Error thrown when a caller passes an invalid argument to the emitter.
 *
 * This is a programmer error (not a transient failure), so it is not retried by the
 * outbox publisher. The class name is stable so callers can catch it explicitly.
 */
export class OutboxEmitterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboxEmitterError'
  }
}

/**
 * Helper for emitting domain events to the outbox within a transaction.
 * Use this instead of directly publishing events to ensure atomicity.
 *
 * Invariants:
 * - Every emitted event is attached to the current tracing/correlation context at emit time.
 * - An explicitly provided `correlationId` always wins over the ambient context.
 * - `version` defaults to `1` when not supplied.
 * - Emit is all-or-nothing with respect to the underlying transaction: the caller owns the
 *   transaction and must roll back on failure. The emitter never swallows errors.
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
   * @throws {OutboxEmitterError} When `db` or `event` is missing/invalid.
   */
  async emit(db: Queryable, event: CreateOutboxEvent): Promise<bigint> {
    assertQueryable(db)
    assertEvent(event)
    const eventWithTrace = this.withTracingContext(event)
    return this.repository.create(db, eventWithTrace)
  }

  /**
   * Emit multiple events in a single transaction.
   * Useful for emitting related events atomically.
   *
   * All events are validated before any INSERT is issued, so a bad element in the batch
   * fails fast without leaving a partially-written batch behind in the caller's transaction.
   *
   * @param db - Database connection or transaction client
   * @param events - Events to emit (must be a non-empty array of valid events)
   * @returns The IDs of the created outbox events, in input order
   * @throws {OutboxEmitterError} When `db` is invalid, `events` is not a non-empty array,
   *   exceeds `MAX_BATCH_SIZE`, or contains an invalid event.
   */
  async emitBatch(db: Queryable, events: CreateOutboxEvent[]): Promise<bigint[]> {
    assertQueryable(db)
    if (!Array.isArray(events)) {
      throw new OutboxEmitterError('emitBatch requires an array of events')
    }
    if (events.length === 0) {
      throw new OutboxEmitterError('emitBatch requires at least one event')
    }
    if (events.length > MAX_BATCH_SIZE) {
      throw new OutboxEmitterError(
        `emitBatch supports at most ${MAX_BATCH_SIZE} events per call, received ${events.length}`,
      )
    }

    // Validate every event and resolve tracing context once before writing anything.
    // This guarantees fail-fast behavior and a consistent correlation id across the batch.
    const prepared = events.map((event, index) => {
      try {
        assertEvent(event)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new OutboxEmitterError(`emitBatch event at index ${index} is invalid: ${message}`)
      }
      return this.withTracingContext(event)
    })

    const ids: bigint[] = []
    for (const eventWithTrace of prepared) {
      const id = await this.repository.create(db, eventWithTrace)
      ids.push(id)
    }
    return ids
  }

  /**
   * Attach the current tracing span and correlation id context to an event.
   */
  private withTracingContext(event: CreateOutboxEvent): CreateOutboxEvent {
    const spanContext = trace.getActiveSpan()?.spanSpanContext()
    const { correlationId } = getActiveCorrelationIds()
    return {
      ...event,
      version: event.version ?? 1,
      tenantId: event.tenantId,
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      tracestate: spanContext?.traceState?.serialize(),
      correlationId: event.correlationId ?? correlationId,
    }
  }
}

function assertQueryable(db: Queryable): void {
  if (db == null || typeof db !== 'object' || typeof (db as { query?: unknown }).query !== 'function') {
    throw new OutboxEmitterError('expected a database connection with a query() method')
  }
}

function assertEvent(event: CreateOutboxEvent): void {
  if (event == null || typeof event !== 'object') {
    throw new OutboxEmitterError('event must be an object')
  }
  if (typeof event.aggregateType !== 'string' || event.aggregateType.length === 0) {
    throw new OutboxEmitterError('event.aggregateType is required')
  }
  if (typeof event.aggregateId !== 'string' || event.aggregateId.length === 0) {
    throw new OutboxEmitterError('event.aggregateId is required')
  }
  if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
    throw new OutboxEmitterError('event.eventType is required')
  }
  if (event.version !== undefined && (!event.version || event.version < 1)) {
    throw new OutboxEmitterError('event.version must be a positive integer')
  }
}

/**
 * Singleton instance for convenience.
 */
export const outboxEmitter = new OutboxEventEmitter()
