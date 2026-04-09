import type { Queryable } from '../repositories/queryable.js'
import type { OutboxEvent, CreateOutboxEvent, OutboxEventStatus, OutboxCleanupConfig } from './types.js'

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
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, max_retries)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.maxRetries ?? 5,
      ]
    )
    return BigInt(result.rows[0].id)
  }

  /**
   * Fetch pending events for processing, ordered by creation time.
   * Uses FOR UPDATE SKIP LOCKED to avoid contention between workers.
   */
  async fetchPendingForProcessing(db: Queryable, limit: number = 100): Promise<OutboxEvent[]> {
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
                   retry_count, max_retries, created_at, processed_at, error_message`,
        [limit]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
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
                   retry_count, max_retries, created_at, processed_at, error_message`,
        [limit]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
    }
  }

  /**
   * Mark an event as successfully published.
   */
  async markPublished(db: Queryable, eventId: bigint): Promise<void> {
    await db.query(
      `UPDATE event_outbox
       SET status = 'published', processed_at = NOW()
       WHERE id = $1`,
      [eventId.toString()]
    )
  }

  /**
   * Mark an event as failed and increment retry count.
   * If max retries exceeded, status remains 'failed'.
   */
  async markFailed(db: Queryable, eventId: bigint, errorMessage: string): Promise<void> {
    await db.query(
      `UPDATE event_outbox
       SET status = CASE 
         WHEN retry_count + 1 >= max_retries THEN 'failed'
         ELSE 'pending'
       END,
       retry_count = retry_count + 1,
       error_message = $2,
       processed_at = CASE 
         WHEN retry_count + 1 >= max_retries THEN NOW()
         ELSE NULL
       END
       WHERE id = $1`,
      [eventId.toString(), errorMessage]
    )
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
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message
       FROM event_outbox
       WHERE aggregate_type = $1 AND aggregate_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [aggregateType, aggregateId, limit]
    )

    return result.rows.map(row => ({
      id: BigInt(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: new Date(row.created_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
      errorMessage: row.error_message,
    }))
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
  }> {
    const result = await db.query<{ status: OutboxEventStatus; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM event_outbox
       GROUP BY status`
    )

    const stats = { pending: 0, processing: 0, published: 0, failed: 0 }
    for (const row of result.rows) {
      stats[row.status] = parseInt(row.count, 10)
    }
    return stats
  }
}
