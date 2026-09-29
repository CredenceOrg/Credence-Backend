import { Queryable } from './queryable.js'
import { BaseRepository } from './baseRepository.js'
import { v4 as uuidv4 } from 'uuid'

export type FailedEventStatus = 'failed' | 'replayed' | 'skipped'

export interface FailedInboundEvent {
  id: string
  eventType: string
  eventData: any
  failureReason?: string
  replayToken: string
  status: FailedEventStatus
  createdAt: Date
  updatedAt: Date
  retryCount: number
  lastRetriedAt?: Date
}

export interface CreateFailedEventInput {
  eventType: string
  eventData: any
  failureReason?: string
  replayToken?: string
}

export const FailedEventStatuses: readonly FailedEventStatus[] = ['failed', 'replayed', 'skipped'] as const

export const TERMINAL_FAILED_EVENT_STATUSES: readonly FailedEventStatus[] = ['replayed', 'skipped'] as const

export const MAX_BATCH_SIZE = 1000

export const MAX_LIST_LIMIT = 500

export const DEFAULT_LIST_LIMIT = 50

export class FailedInboundEventsRepositoryError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message)
    this.name = 'FailedInboundEventsRepositoryError'
  }
}

type FailedEventRow = {
  id: string
  event_type: string
  event_data: any
  failure_reason?: string
  replay_token: string
  status: FailedEventStatus
  created_at: Date | string
  updated_at: Date | string
  retry_count: number
  last_retried_at?: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const isValidStatus = (value: unknown): value is FailedEventStatus =>
  typeof value === 'string' && (FailedEventStatuses as readonly string[]).includes(value)

const mapFailedEvent = (row: FailedEventRow): FailedInboundEvent => ({
  id: row.id,
  eventType: row.event_type,
  eventData: typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data,
  failureReason: row.failure_reason,
  replayToken: row.replay_token,
  status: row.status,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
  retryCount: row.retry_count,
  lastRetriedAt: row.last_retried_at ? toDate(row.last_retried_at) : undefined,
})

export class FailedInboundEventsRepository extends BaseRepository {

  async create(input: CreateFailedEventInput): Promise<FailedInboundEvent> {
    if (!input || typeof input !== 'object') {
      throw new FailedInboundEventsRepositoryError('create requires an input object', 'INVALID_INPUT')
    }
    if (typeof input.eventType !== 'string' || input.eventType.trim().length === 0) {
      throw new FailedInboundEventsRepositoryError('eventType must be a non-empty string', 'INVALID_EVENT_TYPE')
    }
    if (input.eventData === undefined) {
      throw new FailedInboundEventsRepositoryError('eventData is required', 'INVALID_EVENT_DATA')
    }

    const replayToken = input.replayToken || uuidv4()
    const result = await this.db.query<FailedEventRow>(
      `
      INSERT INTO failed_inbound_events (event_type, event_data, failure_reason, replay_token, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (replay_token) DO NOTHING
      RETURNING id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      `,
      [input.eventType, JSON.stringify(input.eventData), input.failureReason, replayToken, 'failed']
    )

    if (!result.rows[0]) {
      // Duplicate replay token: the event was already recorded. Return the
      // existing row so callers stay idempotent and do not lose data.
      const existing = await this.findByReplayToken(replayToken)
      if (existing) {
        return existing
      }
      throw new FailedInboundEventsRepositoryError(
        'Failed to create failed inbound event',
        'CREATE_FAILED',
      )
    }

    return mapFailedEvent(result.rows[0])
  }

  async findById(id: string): Promise<FailedInboundEvent | null> {
    if (typeof id !== 'string' || id.length === 0) {
      return null
    }
    const result = await this.db.query<FailedEventRow>(
      `
      SELECT id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      FROM failed_inbound_events
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapFailedEvent(result.rows[0]) : null
  }

  async findByReplayToken(replayToken: string): Promise<FailedInboundEvent | null> {
    if (typeof replayToken !== 'string' || replayToken.length === 0) {
      return null
    }
    const result = await this.db.query<FailedEventRow>(
      `
      SELECT id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      FROM failed_inbound_events
      WHERE replay_token = $1
      `,
      [replayToken]
    )

    return result.rows[0] ? mapFailedEvent(result.rows[0]) : null
  }

  /**
   * Transitions an event to a new status. Terminal states (replayed, skipped)
   * are idempotent: repeating the same transition is a no-op. Attempting to
   * move a terminal event back to 'failed' is rejected to prevent replay
   * regressions. Returns the updated row, or null when the id does not exist.
   */
  async updateStatus(id: string, status: FailedEventStatus): Promise<FailedInboundEvent | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new FailedInboundEventsRepositoryError('id must be a non-empty string', 'INVALID_ID')
    }
    if (!isValidStatus(status)) {
      throw new FailedInboundEventsRepositoryError(
        `unsupported status: ${String(status)}`,
        'INVALID_STATUS',
      )
    }

    const result = await this.db.query<FailedEventRow>(
      `
      UPDATE failed_inbound_events
      SET status = $1, updated_at = NOW()
      WHERE id = $2
        AND NOT (status IN ('replayed', 'skipped') AND $1 = 'failed')
      RETURNING id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      `,
      [status, id]
    )

    if (result.rows[0]) {
      return mapFailedEvent(result.rows[0])
    }

    // No row updated: either the id does not exist, or the transition was
    // rejected because the event is already terminal. Return the current
    // state so callers can observe it without losing data.
    return this.findById(id)
  }

  /**
   * Atomically records a retry attempt and moves the event back to
   * 'failed'. Returns null when the event is already terminal so a replay
   * cannot be retried after it has been completed.
   */
  async incrementRetryCount(id: string): Promise<FailedInboundEvent | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new FailedInboundEventsRepositoryError('id must be a non-empty string', 'INVALID_ID')
    }

    const result = await this.db.query<FailedEventRow>(
      `
      UPDATE failed_inbound_events
      SET retry_count = retry_count + 1, last_retried_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND status = 'failed'
      RETURNING id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      `,
      [id]
    )

    return result.rows[0] ? mapFailedEvent(result.rows[0]) : null
  }

  async list(filters: { status?: FailedEventStatus; type?: string }, limit = DEFAULT_LIST_LIMIT, offset = 0): Promise<{ events: FailedInboundEvent[], total: number }> {
    if (filters && filters.status !== undefined && !isValidStatus(filters.status)) {
      throw new FailedInboundEventsRepositoryError(
        `unsupported status filter: ${String(filters.status)}`,
        'INVALID_STATUS',
      )
    }

    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT
    const safeOffset = Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0

    let whereClause = ''
    const params: any[] = []

    if (filters.status) {
      params.push(filters.status)
      whereClause += `WHERE status = $${params.length} `
    }

    if (filters.type) {
      params.push(filters.type)
      whereClause += whereClause ? 'AND ' : 'WHERE'
      whereClause += `event_type = $${params.length} `
    }

    const eventsResult = await this.db.query<FailedEventRow>(
      `
      SELECT id, event_type, event_data, failure_reason, replay_token, status, created_at, updated_at, retry_count, last_retried_at
      FROM failed_inbound_events
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, safeLimit, safeOffset]
    )

    const countResult = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM failed_inbound_events
      ${whereClause}
      `,
      params
    )

    return {
      events: eventsResult.rows.map(mapFailedEvent),
      total: parseInt(countResult.rows[0]?.count ?? '0', 10)
    }
  }

  async countByStatus(): Promise<{ status: FailedEventStatus; count: number }[]> {
    const result = await this.db.query<{ status: FailedEventStatus; count: string }>(
      `
      SELECT status, COUNT(*)::TEXT AS count
      FROM failed_inbound_events
      GROUP BY status
      `
    )
    return result.rows.map((row) => ({ status: row.status, count: parseInt(row.count, 10) }))
  }

  /**
   * Deletes terminal events created before `before` in bounded batches.
   * Returns the number of rows deleted. A non-positive batchSize is a no-op
   * so a misconfigured caller cannot accidentally delete unbounded rows.
   */
  async deleteTerminalEvents(
    before: Date,
    batchSize: number,
  ): Promise<number> {
    if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
      throw new FailedInboundEventsRepositoryError('before must be a valid Date', 'INVALID_DATE')
    }
    if (!Number.isFinite(batchSize) || Math.trunc(batchSize) <= 0) {
      return 0
    }
    const safeBatchSize = Math.min(Math.trunc(batchSize), MAX_BATCH_SIZE)

    const result = await this.db.query(
      `
      DELETE FROM failed_inbound_events
      WHERE ctid IN (
        SELECT ctid FROM failed_inbound_events
        WHERE status IN ('replayed', 'skipped')
          AND created_at < $1
        ORDER BY created_at ASC, ctid ASC
        LIMIT $2
      )
      `,
      [before.toISOString(), safeBatchSize]
    )
    return result.rowCount ?? 0
  }

  async countTerminalEvents(before: Date): Promise<number> {
    if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
      throw new FailedInboundEventsRepositoryError('before must be a valid Date', 'INVALID_DATE')
    }
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::TEXT AS count
      FROM failed_inbound_events
      WHERE status IN ('replayed', 'skipped')
        AND created_at < $1
      `,
      [before.toISOString()]
    )
    return parseInt(result.rows[0]?.count ?? '0', 10)
  }
}
