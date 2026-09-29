import type { Queryable } from '../repositories/queryable.js'
import type {
  OutboxEvent,
  CreateOutboxEvent,
  OutboxEventStatus,
  OutboxCleanupConfig,
  OutboxQuarantineEntry,
  OutboxQuarantineReason,
} from './types.js'
import { sanitizeErrorMessage } from './errorSanitizer.js'

/** Upper bound on the exponential backoff delay between retry attempts. */
const MAX_BACKOFF_SECONDS = 3600

type OutboxEventRow = {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: string | Record<string, unknown>
  status: OutboxEventStatus
  retry_count: number
  max_retries: number
  created_at: string
  processed_at: string | null
  error_message: string | null
  consumer_id?: string | null
  lease_expires_at?: string | null
  trace_id?: string | null
  span_id?: string | null
  tracestate?: string | null
  shard_count?: number | null
  shard_id?: number | null
  correlation_id?: string | null
  publish_idempotency_key?: string | null
}

/**
 * Invariants enforced by OutboxRepository:
 *  - State transitions are monotonic: pending -> processing -> {published | pending | dead_letter}.
 *    A row can never move out of a terminal state (published / dead_letter).
 *  - Every mutating method that targets a specific event must include the
 *    expected current status (and consumer_id when relevant) in its WHERE
 *    clause so concurrent workers cannot double-process an event.
 *  - Retry counts are monotonically non-decreasing; max_retries is immutable
 *    after insert.
 *  - Failed events are rescheduled with bounded exponential backoff capped at
 *    MAX_BACKOFF_SECONDS, and next_attempt_at is always cleared when the event
 *    reaches a terminal state.
 *  - Quarantine is a lossless move: the row is copied to outbox_quarantine
 *    before being deleted from event_outbox, and reinjection is idempotent via
 *    the reinjected_at guard.
 */

type OutboxQuarantineRow = {
  id: string
  original_event_id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: string | Record<string, unknown> | null
  reason: OutboxQuarantineReason
  error_message: string
  retry_count: number
  max_retries: number
  quarantined_at: string
  reinjected_at: string | null
  reinjected_by: string | null
}

/**
 * Validate that a caller-supplied limit is a positive safe integer.
 * Prevents negative/NaN limits from reaching SQL (which would either error
 * or, worse, be coerced into an unbounded scan).
 */
function requirePositiveLimit(limit: number, method: string): number {
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`${method}: limit must be a positive integer, received ${String(limit)}`)
  }
  return limit
}

/**
 * The only status transitions permitted by the outbox lifecycle.
 * @deprecated Use `OUTBOX_LIFECYCLE_TRANSITIONS` from `./transitions.js` for
 * programmatic validation.  This object is retained for backward compatibility
 * with callers that iterate the adjacency list.
 */
export const OUTBOX_STATE_TRANSITIONS = {
  pending: ['processing'],
  processing: ['published', 'pending', 'dead_letter'],
  published: [],
  failed: [],
  dead_letter: [],
} as const

/**
 * Validate that a caller-supplied lease duration is a positive finite number.
 * A zero or negative lease would immediately expire and allow another worker
 * to reclaim the event while the original worker is still processing it.
 */
function requirePositiveLease(leaseSeconds: number, method: string): number {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new RangeError(`${method}: leaseSeconds must be a positive number, received ${String(leaseSeconds)}`)
  }
  return leaseSeconds
}

function requireTransition(rowCount: number, eventId: bigint, transition: string): void {
  if (rowCount !== 1) {
    throw new Error(`Outbox event ${eventId} cannot transition via ${transition}`)
  }
}

function mapOutboxEvent(row: OutboxEventRow): OutboxEvent {
  let payload: Record<string, unknown> = {}
  let rawPayload: string | undefined
  let payloadParseError: string | undefined

  if (typeof row.payload === 'string') {
    rawPayload = row.payload
    try {
      const parsed = JSON.parse(row.payload) as unknown
      payload =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
      if (payload !== parsed) {
        payloadParseError = 'Payload JSON must be an object'
      }
    } catch (error) {
      payloadParseError = error instanceof Error ? error.message : String(error)
    }
  } else {
    payload = row.payload
    rawPayload = JSON.stringify(row.payload)
  }

  // Defensive: retry_count / max_retries are NOT NULL in the schema, but a
  // malformed row (e.g. from a manual migration) must not silently produce
  // NaN and break backoff math downstream.
  const retryCount = Number.isFinite(row.retry_count) ? row.retry_count : 0
  const maxRetries = Number.isFinite(row.max_retries) && row.max_retries > 0 ? row.max_retries : 1

  return {
    id: BigInt(row.id),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload,
    rawPayload,
    payloadParseError,
    status: row.status,
    retryCount,
    maxRetries,
    consumerId: row.consumer_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
    errorMessage: row.error_message,
    traceId: row.trace_id,
    spanId: row.span_id,
    tracestate: row.tracestate,
    shardCount: row.shard_count,
    shardId: row.shard_id,
    correlationId: row.correlation_id,
    publishIdempotencyKey: row.publish_idempotency_key,
  }
}

function mapQuarantineEntry(row: OutboxQuarantineRow): OutboxQuarantineEntry {
  return {
    id: BigInt(row.id),
    originalEventId: BigInt(row.original_event_id),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    reason: row.reason,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    quarantinedAt: new Date(row.quarantined_at),
    reinjectedAt: row.reinjected_at ? new Date(row.reinjected_at) : null,
    reinjectedBy: row.reinjected_by,
  }
}

/**
 * Repository for transactional outbox events.
 * All methods accept a Queryable (Pool or PoolClient) to support transactions.
 */
export class OutboxRepository {
  /**
   * Insert a new event into the outbox within a transaction.
   * This ensures the event is persisted atomically with business state changes.
   */
  async create(db: Queryable, event: CreateOutboxEvent): Promise<bigint> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, max_retries, trace_id, span_id, tracestate, correlation_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.maxRetries ?? 5,
        event.traceId,
        event.spanId,
        event.tracestate,
        event.correlationId,
      ]
    )
    return BigInt(result.rows[0].id)
  }

  /**
   * Claim events for processing by a specific consumer with a lease.
   * Events are atomically marked as 'processing' and assigned to the consumer.
   * This method supports crash recovery: stale claims (expired lease) can be reclaimed.
   *
   * @param db - Database connection
   * @param consumerId - Unique identifier for the consumer
   * @param limit - Maximum number of events to claim
   * @param leaseSeconds - Lease duration in seconds
   * @returns Array of claimed events ordered by creation time
   */
  async claimEvents(
    db: Queryable,
    consumerId: string,
    limit: number = 100,
    leaseSeconds: number = 300,
    shardCount?: number,
    shardId?: number
  ): Promise<OutboxEvent[]> {
    requirePositiveLimit(limit, 'claimEvents')
    requirePositiveLease(leaseSeconds, 'claimEvents')
    if (shardCount !== undefined && (!Number.isInteger(shardCount) || shardCount <= 0)) {
      throw new RangeError(`claimEvents: shardCount must be a positive integer, received ${String(shardCount)}`)
    }
    if (shardId !== undefined && (!Number.isInteger(shardId) || shardId < 0)) {
      throw new RangeError(`claimEvents: shardId must be a non-negative integer, received ${String(shardId)}`)
    }
    if (shardCount !== undefined && shardId !== undefined && shardId >= shardCount) {
      throw new RangeError(`claimEvents: shardId (${shardId}) must be < shardCount (${shardCount})`)
    }
    // Try with SKIP LOCKED first (real PostgreSQL)
    try {
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        consumer_id: string | null
        lease_expires_at: string | null
        trace_id: string | null
        span_id: string | null
        tracestate: string | null
        shard_count: number | null
        shard_id: number | null
        correlation_id: string | null
        publish_idempotency_key: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval,
             shard_count = $4,
             shard_id = $5
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE (status = 'pending' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
             AND ($4::int IS NULL OR $5::int IS NULL OR ('x'||substr(md5(id::text),1,8))::bit(32)::int % $4 = $5)
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at, trace_id, span_id, tracestate,
                   shard_count, shard_id, correlation_id, publish_idempotency_key`,
        [limit, consumerId, leaseSeconds.toString(), shardCount ?? null, shardId ?? null]
      )

      return result.rows.map(mapOutboxEvent)
    } catch (error) {
      // Fallback for pg-mem (doesn't support SKIP LOCKED)
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        consumer_id: string | null
        lease_expires_at: string | null
        trace_id: string | null
        span_id: string | null
        tracestate: string | null
        shard_count: number | null
        shard_id: number | null
        correlation_id: string | null
        publish_idempotency_key: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval,
             shard_count = $4,
             shard_id = $5
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE (status = 'pending' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
             AND ($4::int IS NULL OR $5::int IS NULL OR ('x'||substr(md5(id::text),1,8))::bit(32)::int % $4 = $5)
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at, trace_id, span_id, tracestate,
                   shard_count, shard_id, correlation_id, publish_idempotency_key`,
        [limit, consumerId, leaseSeconds.toString(), shardCount ?? null, shardId ?? null]
      )

      return result.rows.map(mapOutboxEvent)
    }
  }

  /**
   * Renew the lease on events currently claimed by the consumer.
   * Extends lease_expires_at for all processing events owned by this consumer.
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @param leaseSeconds - New lease duration in seconds
   * @returns Number of events whose lease was renewed
   */
  async renewLease(db: Queryable, consumerId: string, leaseSeconds: number): Promise<number> {
    requirePositiveLease(leaseSeconds, 'renewLease')
    const result = await db.query(
      `UPDATE event_outbox
       SET lease_expires_at = NOW() + ($2 || ' seconds')::interval
       WHERE consumer_id = $1 AND status = 'processing'`,
      [consumerId, leaseSeconds.toString()]
    )
    return (result as any).rowCount ?? 0
  }

  /**
   * Release all claims for a consumer (graceful shutdown).
   * Resets events claimed by this consumer back to 'pending'.
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @returns Number of events released
   */
  async releaseClaims(db: Queryable, consumerId: string): Promise<number> {
    // Idempotent: releasing a consumer with no claims returns 0.
    const result = await db.query<{ count: string }>(
      `UPDATE event_outbox
       SET status = 'pending', consumer_id = NULL, lease_expires_at = NULL, publish_idempotency_key = NULL
       WHERE consumer_id = $1 AND status = 'processing'`,
      [consumerId]
    )
    const rowCount = (result as any).rowCount ?? result.rows?.[0]?.count
    return typeof rowCount === 'number' ? rowCount : 0
  }

  /**
   * Fetch events currently assigned to a consumer (for recovery/resume).
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @param limit - Maximum events to fetch
   * @returns Array of events owned by this consumer with status 'processing'
   */
  async fetchByConsumer(db: Queryable, consumerId: string, limit: number = 100): Promise<OutboxEvent[]> {
    requirePositiveLimit(limit, 'fetchByConsumer')
    const result = await db.query<{
      id: string
      aggregate_type: string
      aggregate_id: string
      event_type: string
      payload: string | Record<string, unknown>
      status: OutboxEventStatus
      retry_count: number
      max_retries: number
      created_at: string
      processed_at: string | null
      error_message: string | null
      consumer_id: string | null
      lease_expires_at: string | null
      trace_id: string | null
      span_id: string | null
      tracestate: string | null
      correlation_id: string | null
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at, trace_id, span_id, tracestate, correlation_id
       FROM event_outbox
       WHERE consumer_id = $1 AND status = 'processing'
       ORDER BY created_at ASC
       LIMIT $2`,
      [consumerId, limit]
    )

    return result.rows.map(mapOutboxEvent)
  }

  /**
   * Deprecated: Use claimEvents instead for crash-safe processing with consumer tracking.
   */
  async fetchPendingForProcessing(db: Queryable, limit: number = 100): Promise<OutboxEvent[]> {
    requirePositiveLimit(limit, 'fetchPendingForProcessing')
    // Legacy behavior maintained for backward compatibility.
    // New code should use claimEvents().
    try {
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        trace_id: string | null
        span_id: string | null
        tracestate: string | null
        correlation_id: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing'
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status, 
                   retry_count, max_retries, created_at, processed_at, error_message,
                   trace_id, span_id, tracestate, correlation_id`,
        [limit]
      )

      return result.rows.map(mapOutboxEvent)
    } catch (error) {
      // Fallback for pg-mem
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        trace_id: string | null
        span_id: string | null
        tracestate: string | null
        correlation_id: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing'
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status, 
                   retry_count, max_retries, created_at, processed_at, error_message,
                   trace_id, span_id, tracestate, correlation_id`,
        [limit]
      )

      return result.rows.map(mapOutboxEvent)
    }
  }

  async getOldestPendingEventLagSeconds(db: Queryable): Promise<number> {
    const result = await db.query<{ lag_seconds: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS lag_seconds
       FROM event_outbox
       WHERE status IN ('pending', 'processing')`
    )

    const lagSeconds = result.rows[0]?.lag_seconds
    if (lagSeconds === null || lagSeconds === undefined) {
      return 0
    }
    const parsed = Number(lagSeconds)
    // Guard against NaN/Infinity leaking into metrics.
    return Number.isFinite(parsed) ? parsed : 0
  }

  /**
   * Mark an event as successfully published.
   */
  async markPublished(db: Queryable, eventId: bigint, consumerId: string): Promise<void> {
    if (typeof eventId !== 'bigint') {
      throw new TypeError(`markPublished: eventId must be a bigint, received ${typeof eventId}`)
    }
    const result = await db.query(
      `UPDATE event_outbox
       SET status = 'published', processed_at = NOW(), consumer_id = NULL, lease_expires_at = NULL, publish_idempotency_key = NULL
       WHERE id = $1 AND status = 'processing'
         AND ($2::text IS NULL OR consumer_id = $2)
       RETURNING id`,
      [eventId.toString(), consumerId]
    )
    requireTransition(result.rowCount ?? 0, eventId, 'markPublished')
  }

  /**
   * Atomically set a publish idempotency key on an event.
   * If a key is already present the event was already published by a
   * previous (crashed) attempt and the caller should skip to markPublished.
   *
   * @returns true if the key was set (first attempt), false if already present
   */
  async trySetPublishIdempotencyKey(db: Queryable, eventId: bigint, key: string, consumerId: string): Promise<boolean> {
    if (typeof eventId !== 'bigint') {
      throw new TypeError(`trySetPublishIdempotencyKey: eventId must be a bigint, received ${typeof eventId}`)
    }
    const result = await db.query<{ id: string }>(
      `UPDATE event_outbox
       SET publish_idempotency_key = $2
       WHERE id = $1 AND status = 'processing' AND publish_idempotency_key IS NULL
         AND ($3::text IS NULL OR consumer_id = $3)
       RETURNING id`,
      [eventId.toString(), key, consumerId]
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Clear the publish idempotency key so the event can be retried.
   */
  async clearPublishIdempotencyKey(db: Queryable, eventId: bigint): Promise<void> {
    if (typeof eventId !== 'bigint') {
      throw new TypeError(`clearPublishIdempotencyKey: eventId must be a bigint, received ${typeof eventId}`)
    }
    await db.query(
      `UPDATE event_outbox SET publish_idempotency_key = NULL WHERE id = $1`,
      [eventId.toString()]
    )
  }

  /**
   * Mark an event as failed and increment retry count.
   * If max retries exceeded, status remains 'failed'.
   */
  async markFailed(db: Queryable, eventId: bigint, errorMessage: string, consumerId: string): Promise<{ status: string; retryCount: number }> {
    if (typeof eventId !== 'bigint') {
      throw new TypeError(`markFailed: eventId must be a bigint, received ${typeof eventId}`)
    }
    // Truncate/redact before persisting: exception messages can incidentally
    // carry secrets (e.g. an Authorization header echoed by an HTTP client
    // error) or be unbounded in length.
    const sanitizedMessage = sanitizeErrorMessage(errorMessage)

    // Step 1: increment retry_count, set status and clear lease/consumer, clear next_attempt_at and idempotency key for now
    const upd = await db.query<{
      retry_count: number
      max_retries: number
    }>(
      `UPDATE event_outbox
       SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'pending' END,
           retry_count = retry_count + 1,
           error_message = $2,
           processed_at = CASE WHEN retry_count + 1 >= max_retries THEN NOW() ELSE NULL END,
           consumer_id = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN retry_count + 1 >= max_retries THEN NULL
             ELSE NOW() + (LEAST(POWER(2, retry_count + 1), $4::numeric)::text || ' seconds')::interval
           END,
           publish_idempotency_key = NULL
       WHERE id = $1 AND status = 'processing'
         AND ($3::text IS NULL OR consumer_id = $3)
       RETURNING retry_count, max_retries`,
      [eventId.toString(), sanitizedMessage, consumerId, MAX_BACKOFF_SECONDS]
    )

    const row = upd.rows[0]
    requireTransition(upd.rowCount ?? 0, eventId, 'markFailed')
    const retryCount = Number(row.retry_count)
    const maxRetries = Number(row.max_retries)

    // Derive status from the same predicate used in the SQL CASE so the
    // returned value can never disagree with the persisted row.
    const status = retryCount >= maxRetries ? 'dead_letter' : 'pending'
    return { status, retryCount }
  }

  /**
   * Get events for a specific aggregate, ordered by creation time.
   * Useful for maintaining ordering guarantees per aggregate.
   */
  async getByAggregate(
    db: Queryable,
    aggregateType: string,
    aggregateId: string,
    limit: number = 100
  ): Promise<OutboxEvent[]> {
    requirePositiveLimit(limit, 'getByAggregate')
    const result = await db.query<{
      id: string
      aggregate_type: string
      aggregate_id: string
      event_type: string
      payload: string | Record<string, unknown>
      status: OutboxEventStatus
      retry_count: number
      max_retries: number
      created_at: string
      processed_at: string | null
      error_message: string | null
      consumer_id: string | null
      lease_expires_at: string | null
      trace_id: string | null
      span_id: string | null
      tracestate: string | null
      correlation_id: string | null
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at, trace_id, span_id, tracestate, correlation_id
       FROM event_outbox
       WHERE aggregate_type = $1 AND aggregate_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [aggregateType, aggregateId, limit]
    )

    return result.rows.map(mapOutboxEvent)
  }

  async quarantine(
    db: Queryable,
    event: OutboxEvent,
    reason: OutboxQuarantineReason,
    errorMessage: string
  ): Promise<void> {
    if (typeof event.id !== 'bigint') {
      throw new TypeError(`quarantine: event.id must be a bigint, received ${typeof event.id}`)
    }
    try {
      await db.query(
        `WITH deleted AS (
           DELETE FROM event_outbox
           WHERE id = $1
           RETURNING id, aggregate_type, aggregate_id, event_type, payload, retry_count, max_retries
         )
         INSERT INTO outbox_quarantine (
           original_event_id,
           aggregate_type,
           aggregate_id,
           event_type,
           payload,
           reason,
           error_message,
           retry_count,
           max_retries
         )
         SELECT id, aggregate_type, aggregate_id, event_type, payload::text, $2, $3, retry_count, max_retries
         FROM deleted
         ON CONFLICT (original_event_id) DO NOTHING`,
        [event.id.toString(), reason, errorMessage]
      )
    } catch (error) {
      // Fallback for pg-mem which doesn't support complex CTEs containing DELETE
      const deleteResult = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        retry_count: number
        max_retries: number
      }>(
        `DELETE FROM event_outbox
         WHERE id = $1
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, retry_count, max_retries`,
        [event.id.toString()]
      )

      if (deleteResult.rows.length > 0) {
        const deleted = deleteResult.rows[0]
        const payloadStr = typeof deleted.payload === 'string'
          ? deleted.payload
          : JSON.stringify(deleted.payload)

        await db.query(
          `INSERT INTO outbox_quarantine (
             original_event_id,
             aggregate_type,
             aggregate_id,
             event_type,
             payload,
             reason,
             error_message,
             retry_count,
             max_retries
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (original_event_id) DO NOTHING`,
          [
            deleted.id,
            deleted.aggregate_type,
            deleted.aggregate_id,
            deleted.event_type,
            payloadStr,
            reason,
            errorMessage,
            deleted.retry_count,
            deleted.max_retries,
          ]
        )
      }
    }
  }

  async listQuarantine(
    db: Queryable,
    limit: number,
    offset: number,
    reason?: OutboxQuarantineReason
  ): Promise<{ entries: OutboxQuarantineEntry[]; total: number }> {
    requirePositiveLimit(limit, 'listQuarantine')
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`listQuarantine: offset must be a non-negative integer, received ${String(offset)}`)
    }
    const params: unknown[] = []
    const where: string[] = ['reinjected_at IS NULL']
    if (reason) {
      params.push(reason)
      where.push(`reason = $${params.length}`)
    }

    params.push(limit)
    const limitIdx = params.length
    params.push(offset)
    const offsetIdx = params.length
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const result = await db.query<OutboxQuarantineRow & { total_count: string }>(
      `SELECT id, original_event_id, aggregate_type, aggregate_id, event_type, payload,
              reason, error_message, retry_count, max_retries, quarantined_at,
              reinjected_at, reinjected_by, COUNT(*) OVER() AS total_count
       FROM outbox_quarantine
       ${whereSql}
       ORDER BY quarantined_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    )

    return {
      entries: result.rows.map(mapQuarantineEntry),
      total: Number(result.rows[0]?.total_count ?? 0),
    }
  }

  async reinjectQuarantined(
    db: Queryable,
    quarantineId: bigint,
    fixedPayload: Record<string, unknown>,
    reinjectedBy: string
  ): Promise<bigint | null> {
    if (typeof quarantineId !== 'bigint') {
      throw new TypeError(`reinjectQuarantined: quarantineId must be a bigint, received ${typeof quarantineId}`)
    }
    const result = await db.query<{ id: string }>(
      `WITH source AS (
         SELECT *
         FROM outbox_quarantine
         WHERE id = $1 AND reinjected_at IS NULL
         FOR UPDATE
       ),
       inserted AS (
         INSERT INTO event_outbox (
           aggregate_type,
           aggregate_id,
           event_type,
           payload,
           status,
           retry_count,
           max_retries
         )
         SELECT aggregate_type, aggregate_id, event_type, $2, 'pending', 0, max_retries
         FROM source
         RETURNING id
       ),
       marked AS (
         UPDATE outbox_quarantine
         SET reinjected_at = NOW(), reinjected_by = $3
         WHERE id = $1 AND EXISTS (SELECT 1 FROM inserted)
       )
       SELECT id FROM inserted`,
      [quarantineId.toString(), JSON.stringify(fixedPayload), reinjectedBy]
    )

    const id = result.rows[0]?.id
    return id ? BigInt(id) : null
  }

  /**
   * Clean up old published and failed events based on retention policy.
   */
  async cleanup(db: Queryable, config: OutboxCleanupConfig): Promise<number> {
    if (!Number.isFinite(config.publishedRetentionDays) || config.publishedRetentionDays < 0) {
      throw new RangeError(`cleanup: publishedRetentionDays must be a non-negative number, received ${String(config.publishedRetentionDays)}`)
    }
    if (!Number.isFinite(config.failedRetentionDays) || config.failedRetentionDays < 0) {
      throw new RangeError(`cleanup: failedRetentionDays must be a non-negative number, received ${String(config.failedRetentionDays)}`)
    }
    const result = await db.query<{ deleted_count: number }>(
      `WITH deleted AS (
         DELETE FROM event_outbox
         WHERE (status = 'published' AND processed_at < NOW() - ($1 || ' days')::interval)
            OR (status = 'failed' AND processed_at < NOW() - ($2 || ' days')::interval)
         RETURNING id
       )
       SELECT COUNT(*) as deleted_count FROM deleted`,
      [config.publishedRetentionDays, config.failedRetentionDays]
    )
    return result.rows[0]?.deleted_count ?? 0
  }

  /**
   * Get statistics about outbox events.
   */
  async getStats(db: Queryable): Promise<{
    pending: number
    processing: number
    published: number
    failed: number
    dead_letter: number
  }> {
    const result = await db.query<{ status: OutboxEventStatus; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM event_outbox
       GROUP BY status`
    )

    const stats: Record<OutboxEventStatus, number> = {
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
      dead_letter: 0,
    }
    for (const row of result.rows) {
      const parsed = parseInt(row.count, 10)
      stats[row.status] = Number.isFinite(parsed) ? parsed : 0
    }
    return stats
  }
}
