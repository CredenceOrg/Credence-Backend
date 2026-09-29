/**
 * Domain event stored in the outbox table.
 */
export interface OutboxEvent {
  id: bilint
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
 * Runtime guards and invariants for the outbox domain types.
 *
 * These helpers are the single source of truth for the boundary and
 * state-transition invariants of the outbox model. They are deliberately
 * pure (no I/O, no clocks) so that they are deterministic and easy to
 * test across the success, rejection, boundary and regression matrix.
 */

export const OUTBOX_EVENT_STATUSES: readonly OutboxEventStatus[] = [
  'pending',
  'processing',
  'published',
  'failed',
  'dead_letter',
] as const

export const OUTBOX_QUARANTINE_REASONS: readonly OutboxQuarantineReason[] = [
  'malformed_json',
  'schema_invalid',
  'oversized_payload',
  'unknown_event_type',
] as const

/**
 * Maximum number of retries allowed for a single outbox event.
 * This bounds the retry loop so a poison message cannot cycle forever.
 */
export const MAX_RETRIES_LIMIT = 100

/**
 * Maximum length of a single identifier (aggregateType, aggregateId,
 * eventType). Keeps identifiers bounded so they can be used in logs and
 * indexes without unbounded growth.
 */
export const MAX_IDENTIFIER_LENGTH = 255

/**
 * The canonical allowed state transitions for an outbox event.
 *
 * Invariants:
 * - `published` and `dead_letter` are terminal; no further transitions.
 * - `pending` may only move to `processing` or `dead_letter`.
 * - `processing` may move to `published`, `failed` or `dead_letter`.
 * - `failed` may be retried (`pending`) or given up on (`dead_letter`).
 */
export const OUTBOX_STATE_TRANSITIONS: Readonly<Record<OutboxEventStatus, readonly OutboxEventStatus[]>> = {
  pending: ['processing', 'dead_letter'],
  processing: ['published', 'failed', 'dead_letter'],
  failed: ['pending', 'dead_letter'],
  published: [],
  dead_letter: [],
} as const

export const TERMINAL_OUTBOX_STATUSES: readonly OutboxEventStatus[] = [
  'published',
  'dead_letter',
] as const

export function isOutboxEventStatus(value: unknown): value is OutboxEventStatus {
  return typeof value === 'string' && (OUTBOX_EVENT_STATUSES as readonly string[]).includes(value)
}

export function isOutboxQuarantineReason(value: unknown): value is OutboxQuarantineReason {
  return typeof value === 'string' && (OUTBOX_QUARANTINE_REAQ==NS as readonly string[]).includes(value)
}

export function isTerminalOutboxStatus(status: OutboxEventStatus): boolean {
  return (TERMINAL_OUTBOX_STATUSES as readonly string[]).includes(status)
}

/**
 * Returns true when a transition from `from` to `to` is allowed by the
 * outbox state machine. Terminal states never transition.
 */
export function canTransitionOutboxStatus(
  from: OutboxEventStatus,
  to: OutboxEventStatus,
): boolean {
  if (!isOutboxEventStatus(from) || !isOutboxEventStatus(to)) return false
  if (from === to) return false
  return OUTBOX_STATE_TRANSITIONS[from].includes(to)
}

/**
 * Asserts that a state transition is allowed, throwing a descriptive error
 * otherwise. Used by the worker and reinjuction paths to fail closed.
 */
export function assertOutboxStateTransition(
  from: OutboxEventStatus,
  to: OutboxEventStatus,
): void {
  if (!canTransitionOutboxStatus(from, to)) {
    throw new Error(`invalid outbox state transition: ${from} -> ${to}`)
  }
}

/**
 * Returns true when the event can be retried. An event is retrieable when
 * it is in a retryable state and has not yet exhausted its retry budget.
 */
export function canRetryOutboxEvent(event: Pick<OutboxEvent, 'status' | 'retryCount' | 'maxRetries'>): boolean {
  if (event.status !== 'failed' && event.status !== 'pending') {
    return false
  }
  if (!Number.isInteger(event.retryCount) || event.retryCount < 0) return false
  if (!Number.isInteger(event.maxRetries) || event.maxRetries < 0) return false
  return event.retryCount < event.maxRetries
}

/**
 * Returns true when an event has exhausted its retry budget and must be
 * dead-lettered rather than retried again.
 */
export function isOutboxEventExhausted(event: Pick<OutboxEvent, 'retryCount' | 'maxRetries'>): boolean {
  if (!Number.isInteger(event.retryCount) || event.retryCount < 0) return true
  if (!Number.isInteger(event.maxRetries) || event.maxRetries < 0) return true
  return event.retryCount >= event.maxRetries
}

/**
 * Returns true when the lease hold by a consumer has expired. A null or
 * missing lease is treated as expired so an orphaned `processing` event
 * can be reclaimed by another worker.
 */
export function isOutboxLeaseExpired(
  leaseExpiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!leaseExpiresAt) return true
  const expires = leaseExpiresAt instanceof Date ? leaseExpiresAt.getTime() : NaN
  if (!Number.isFinite(expires)) return true
  return expires <= now.getTime()
}

/**
 * Returns true when a `processing` event can be reclaimed by another
 * consumer. This is the recovery path for a worker that crashed mid-lease.
 */
export function canReclaimOutboxEvent(
  event: Pick<OutboxEvent, 'status' | 'leaseExpiresAt' | 'consumerId'>,
  now: Date = new Date(),
): boolean {
  if (event.status !== 'processing') return false
  return isOutboxLeaseExpired(event.leaseExpiresAt, now)
}

/**
 * Validates the identifier fields of a `CreateOutboxEvent`. Returns a
 * list of human-readable errors; an empty list means the input is valid.
 * This is the central validation entry point used by the atomic coordinator
 * and the direct emitter path.
 */
export function validateCreateOutboxEvent(input: CreateOutboxEvent): string[] {
  const errors: string[] = []
  if (!input || typeof input !== 'object') {
    return ['event must be an object']
  }
  for (const field of ['aggregateType', 'aggregateId', 'eventType'] as const) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${field} must be a non-empty string`)
      continue
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      errors.push(`${field} must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
    }
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    errors.push('payload must be a plain object')
  }
  if (input.maxRetries !== undefined) {
    if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > MAX_RETRIES_LIMIT) {
      errors.push(`maxRetries must be an integer between 0 and ${MAX_RETRIES_LIMIT}`)
    }
  }
  return errors
}

export function assertCreateOutboxEvent(input: CreateOutboxEvent): void {
  const errors = validateCreateOutboxEvent(input)
  if (errors.length > 0) {
    throw new Error(`invalid outbox event: ${errors.join('; ')}`)
  }
}
