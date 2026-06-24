import type { Queryable } from '../repositories/queryable.js'
import type {
  OutboxEvent,
  CreateOutboxEvent,
  OutboxEventStatus,
  OutboxCleanupConfig,
  OutboxQuarantineEntry,
  OutboxQuarantineReason,
} from './types.js'

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
}

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

  return {
    id: BigInt(row.id),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload,
    rawPayload,
    payloadParseError,
    status: row.status,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    consumerId: row.consumer_id,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
    errorMessage: row.error_message,
    traceId: row.trace_id,
    spanId: row.span_id,
    tracestate: row.tracestate,
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
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, max_retries, trace_id, span_id, tracestate)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
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
    leaseSeconds: number = 300
  ): Promise<OutboxEvent[]> {
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
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE (status = 'pending' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at, trace_id, span_id, tracestate`,
        [limit, consumerId, leaseSeconds.toString()]
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
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE (status = 'pending' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at, trace_id, span_id, tracestate`,
        [limit, consumerId, leaseSeconds.toString()]
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
    const result = await db.query<{ count: string }>(
      `UPDATE event_outbox
       SET status = 'pending', consumer_id = NULL, lease_expires_at = NULL
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
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at, trace_id, span_id, tracestate
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
                   trace_id, span_id, tracestate`,
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
                   trace_id, span_id, tracestate`,
        [limit]
      )

      return result.rows.map(mapOutboxEvent)
    }
  }

  /**
   * Mark an event as successfully published.
   */
  async markPublished(db: Queryable, eventId: bigint): Promise<void> {
    await db.query(
      `UPDATE event_outbox
       SET status = 'published', processed_at = NOW(), consumer_id = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [eventId.toString()]
    )
  }

  /**
   * Mark an event as failed and increment retry count.
   * If max retries exceeded, status remains 'failed'.
   */
  async markFailed(db: Queryable, eventId: bigint, errorMessage: string): Promise<{ status: string; retryCount: number }> {
    // Step 1: increment retry_count, set status and clear lease/consumer, clear next_attempt_at for now
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
           next_attempt_at = NULL
       WHERE id = $1
       RETURNING retry_count, max_retries`,
      [eventId.toString(), errorMessage]
    )

    const row = upd.rows[0]
    const retryCount = row ? Number(row.retry_count) : 0
    const maxRetries = row ? Number(row.max_retries) : 0

    // If not yet exhausted, compute exponential backoff in JS and update next_attempt_at
    if (retryCount < maxRetries) {
      const delaySeconds = Math.pow(2, retryCount)
      await db.query(
        `UPDATE event_outbox SET next_attempt_at = NOW() + ($2 || ' seconds')::interval WHERE id = $1`,
        [eventId.toString(), String(Math.floor(delaySeconds))]
      )
    }

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
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at, trace_id, span_id, tracestate
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
      stats[row.status] = parseInt(row.count, 10)
    }
    return stats
  }
}
