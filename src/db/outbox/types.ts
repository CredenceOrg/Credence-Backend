/**
 * Outbox domain types and runtime invariants.
 *
 * Invariants enforced by `assertOutboxEventInvariants` and the boundary
 * helpers below:
 *
 * 1. `retryCount` is always in `[0, maxRetries]`. A `retryCount` equal to
 *    `maxRetries` means the event is exhausted and must transition to
 *    `dead_letter` (or `failed` while awaiting quarantine) rather than
 *    being re-leased.
 * 2. `maxRetries` is a non-negative safe integer. Negative or non-finite
 *    values are rejected at creation time so retry accounting cannot
 *    underflow or loop forever.
 * 3. `status === 'processing'` requires a non-null `leaseExpiresAt` and a
 *    non-null `consumerId`; otherwise a crashed worker could leave an
 *    event permanently stuck without a recovery path.
 * 4. `status === 'published'` requires a non-null `processedAt` so
 *    downstream retention/cleanup can reason about age deterministically.
 * 5. `status === 'dead_letter'` requires `retryCount >= maxRetries` so a
 *    dead-lettered event cannot be silently retried without an explicit
 *    reinjection that resets the counters.
 * 6. `publishIdempotencyKey`, when present, must be a non-empty string so
 *    the publisher can rely on it as a dedupe key.
 *
 * These invariants are intentionally checked at the type boundary (rather
 * than only in SQL) so that in-memory fixtures, tests, and any future
 * non-Postgres adapters share the same guarantees.
 */

/**
 * Domain event stored in the outbox table.
 */
export interface OutboxEvent {
  id: bigint
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  rawPayload?: string
  payloadParseError?: string
  status: OutboxEventStatus
  retryCount: number
  maxRetries: number
  consumerId?: string | null
  leaseExpiresAt?: Date | null
  createdAt: Date
  processedAt: Date | null
  errorMessage: string | null
  traceId?: string | null
  spanId?: string | null
  tracestate?: string | null
  shardCount?: number | null
  shardId?: number | null
  /**
   * Application-level correlation id (distinct from the OTel trace/span
   * ids above) captured from the originating HTTP request's tracing
   * context at emit time. Restored into the tracing context when this
   * event is published so downstream logs and outbound webhook requests
   * can be tied back to the request that caused them.
   */
  correlationId?: string | null
  /**
   * Set before publishing to prevent duplicate emissions if the worker
   * crashes mid-batch.  When present the publisher treats the event as
   * already delivered and skips straight to markPublished.
   */
  publishIdempotencyKey?: string | null
}

export type OutboxEventStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_letter'

export const OUTBOX_EVENT_STATUSES: readonly OutboxEventStatus[] = [
  'pending',
  'processing',
  'published',
  'failed',
  'dead_letter',
] as const

export type OutboxQuarantineReason =
  | 'malformed_json'
  | 'schema_invalid'
  | 'oversized_payload'
  | 'unknown_event_type'

export interface OutboxQuarantineEntry {
  id: bigint
  originalEventId: bigint
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown> | string | null
  reason: OutboxQuarantineReason
  errorMessage: string
  retryCount: number
  maxRetries: number
  quarantinedAt: Date
  reinjectedAt: Date | null
  reinjectedBy: string | null
}

export const OUTBOX_QUARANTINE_REASONS: readonly OutboxQuarantineReason[] = [
  'malformed_json',
  'schema_invalid',
  'oversized_payload',
  'unknown_event_type',
] as const

/**
 * Input for creating a new outbox event.
 */
export interface CreateOutboxEvent {
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  maxRetries?: number
  traceId?: string | null
  spanId?: string | null
  tracestate?: string | null
  correlationId?: string | null
}

/**
 * Configuration for outbox cleanup policy.
 */
export interface OutboxCleanupConfig {
  /** Delete published events older than this many days. Default: 7 */
  publishedRetentionDays: number
  /** Delete failed events older than this many days. Default: 30 */
  failedRetentionDays: number
}

/**
 * Default retry budget applied when `CreateOutboxEvent.maxRetries` is
 * omitted. Kept as a named constant so tests and callers can assert on it
 * without duplicating the literal.
 */
export const DEFAULT_OUTBOX_MAX_RETRIES = 5

/**
 * Upper bound on `maxRetries` accepted at the boundary. Guards against
 * pathological configurations that would keep an event alive indefinitely.
 */
export const MAX_OUTBOX_MAX_RETRIES = 100

/**
 * Error thrown when an outbox event or creation input violates a boundary
 * invariant. Callers should treat this as a programming/validation error
 * (not a transient failure) and must not retry blindly.
 */
export class OutboxInvariantError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'OutboxInvariantError'
    this.code = code
    this.details = details
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

/**
 * Validates the retry budget on a creation input. Returns the normalized
 * value (default applied) or throws `OutboxInvariantError`.
 */
export function normalizeMaxRetries(maxRetries: number | undefined): number {
  if (maxRetries === undefined) {
    return DEFAULT_OUTBOX_MAX_RETRIES
  }
  if (typeof maxRetries !== 'number' || !Number.isFinite(maxRetries)) {
    throw new OutboxInvariantError(
      'invalid_max_retries',
      'maxRetries must be a finite number',
      { maxRetries },
    )
  }
  if (!Number.isInteger(maxRetries)) {
    throw new OutboxInvariantError(
      'invalid_max_retries',
      'maxRetries must be an integer',
      { maxRetries },
    )
  }
  if (maxRetries < 0) {
    throw new OutboxInvariantError(
      'invalid_max_retries',
      'maxRetries must be >= 0',
      { maxRetries },
    )
  }
  if (maxRetries > MAX_OUTBOX_MAX_RETRIES) {
    throw new OutboxInvariantError(
      'invalid_max_retries',
      `maxRetries must be <= ${MAX_OUTBOX_MAX_RETRIES}`,
      { maxRetries, limit: MAX_OUTBOX_MAX_RETRIES },
    )
  }
  return maxRetries
}

/**
 * Validates a `CreateOutboxEvent` payload before it is persisted. Throws
 * `OutboxInvariantError` on the first violation so callers get a
 * deterministic, diagnosable failure instead of a partial insert.
 */
export function assertCreateOutboxEventValid(input: CreateOutboxEvent): void {
  if (!isNonEmptyString(input.aggregateType)) {
    throw new OutboxInvariantError(
      'invalid_aggregate_type',
      'aggregateType must be a non-empty string',
    )
  }
  if (!isNonEmptyString(input.aggregateId)) {
    throw new OutboxInvariantError(
      'invalid_aggregate_id',
      'aggregateId must be a non-empty string',
    )
  }
  if (!isNonEmptyString(input.eventType)) {
    throw new OutboxInvariantError(
      'invalid_event_type',
      'eventType must be a non-empty string',
    )
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new OutboxInvariantError(
      'invalid_payload',
      'payload must be a plain object',
    )
  }
  normalizeMaxRetries(input.maxRetries)
}

/**
 * Asserts the runtime invariants of a persisted `OutboxEvent`. Intended to
 * be called after loading a row (or constructing a fixture) so that
 * corrupted state is surfaced immediately rather than during a later
 * state transition.
 */
export function assertOutboxEventInvariants(event: OutboxEvent): void {
  if (!Number.isInteger(event.retryCount) || event.retryCount < 0) {
    throw new OutboxInvariantError(
      'invalid_retry_count',
      'retryCount must be a non-negative integer',
      { retryCount: event.retryCount },
    )
  }
  if (!Number.isInteger(event.maxRetries) || event.maxRetries < 0) {
    throw new OutboxInvariantError(
      'invalid_max_retries',
      'maxRetries must be a non-negative integer',
      { maxRetries: event.maxRetries },
    )
  }
  if (event.retryCount > event.maxRetries) {
    throw new OutboxInvariantError(
      'retry_count_exceeds_max',
      'retryCount must not exceed maxRetries',
      { retryCount: event.retryCount, maxRetries: event.maxRetries },
    )
  }
  if (!OUTBOX_EVENT_STATUSES.includes(event.status)) {
    throw new OutboxInvariantError(
      'invalid_status',
      `unknown outbox status: ${String(event.status)}`,
      { status: event.status },
    )
  }
  if (event.status === 'processing') {
    if (!isNonEmptyString(event.consumerId)) {
      throw new OutboxInvariantError(
        'processing_missing_consumer',
        'processing events must have a consumerId',
      )
    }
    if (!isValidDate(event.leaseExpiresAt)) {
      throw new OutboxInvariantError(
        'processing_missing_lease',
        'processing events must have a valid leaseExpiresAt',
      )
    }
  }
  if (event.status === 'published' && !isValidDate(event.processedAt)) {
    throw new OutboxInvariantError(
      'published_missing_processed_at',
      'published events must have a processedAt timestamp',
    )
  }
  if (event.status === 'dead_letter' && event.retryCount < event.maxRetries) {
    throw new OutboxInvariantError(
      'dead_letter_before_exhaustion',
      'dead_letter events must have exhausted their retry budget',
      { retryCount: event.retryCount, maxRetries: event.maxRetries },
    )
  }
  if (
    event.publishIdempotencyKey !== undefined &&
    event.publishIdempotencyKey !== null &&
    !isNonEmptyString(event.publishIdempotencyKey)
  ) {
    throw new OutboxInvariantError(
      'invalid_publish_idempotency_key',
      'publishIdempotencyKey must be a non-empty string when present',
    )
  }
}

/**
 * Returns true when a `processing` event's lease has expired relative to
 * `now`. Pending, published, failed, and dead_letter events are never
 * considered lease-expired. This is the single source of truth used by the
 * recovery path so that a crashed worker's event can be safely reclaimed.
 */
export function isLeaseExpired(event: OutboxEvent, now: Date): boolean {
  if (event.status !== 'processing') {
    return false
  }
  if (!isValidDate(event.leaseExpiresAt)) {
    // A processing event without a valid lease is unrecoverable via the
    // normal path; treat it as expired so recovery can reclaim it.
    return true
  }
  return event.leaseExpiresAt.getTime() <= now.getTime()
}

/**
 * Returns true when the event has exhausted its retry budget and must not
 * be re-leased. Callers should transition such events to `dead_letter`.
 */
export function isRetryExhausted(event: OutboxEvent): boolean {
  return event.retryCount >= event.maxRetries
}

/**
 * Computes the next retry count after a failed attempt. Throws if the
 * event has already exhausted its budget so callers cannot accidentally
 * increment past `maxRetries`.
 */
export function nextRetryCount(event: OutboxEvent): number {
  if (isRetryExhausted(event)) {
    throw new OutboxInvariantError(
      'retry_exhausted',
      'cannot increment retryCount beyond maxRetries',
      { retryCount: event.retryCount, maxRetries: event.maxRetries },
    )
  }
  return event.retryCount + 1
}
