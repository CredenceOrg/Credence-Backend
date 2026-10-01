/**
 * Terminal statuses are those from which an outbox event will not
 * transition again under normal operation.  Recovery tooling and the
 * publisher rely on this classification to decide whether an event is
 * eligible for retry, reinjection, or cleanup.
 */
export const TERMINAL_OUTBOX_STATUSES: ReadonlyArray<OutboxEventStatus> = [
  'published',
  'dead_letter',
]

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
  /**
   * Timestamp of the most recent publish attempt.  Used by recovery
   * tooling to detect stale `processing` rows whose lease has expired
   * and to compute retry backoff without relying on wall-clock drift
   * between the worker and the database.
   */
  lastAttemptAt?: Date | null
}

export type OutboxEventStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_letter'

/**
 * Terminal statuses from which no further state transition is permitted.
 *
 * Invariant: once an event reaches a terminal status it MUST NOT be
 * re-queued, re-published, or re-processed. Recovery logic (lease
 * reclamation, retry scheduling, reinjection) must treat these as
 * immutable so that a crash mid-batch cannot cause duplicate delivery
 * or silent data loss.
 */
export const TERMINAL_OUTBOX_STATUSES: readonly OutboxEventStatus[] = [
  'published',
  'dead_letter',
] as const

/**
 * Statuses that may still transition to another status.
 */
export const NON_TERMINAL_OUTBOX_STATUSES: readonly OutboxEventStatus[] = [
  'pending',
  'processing',
  'failed',
] as const

/**
 * Returns true when `status` is a terminal outbox status.
 *
 * Deterministic for every member of {@link OutboxEventStatus}; unknown
 * runtime values (e.g. from an unvalidated DB row) return false so that
 * callers fail closed by treating them as non-terminal and re-validating.
 */
export function isTerminalOutboxStatus(status: OutboxEventStatus): boolean {
  return TERMINAL_OUTBOX_STATUSES.includes(status)
}

/**
 * Returns true when `status` is a known, non-terminal outbox status.
 */
export function isNonTerminalOutboxStatus(status: OutboxEventStatus): boolean {
  return NON_TERMINAL_OUTBOX_STATUSES.includes(status)
}

/**
 * Returns true when `value` is a valid {@link OutboxEventStatus}.
 *
 * Used at trust boundaries (DB reads, queue payloads, reinjection input)
 * to reject unknown statuses before they reach state-transition logic.
 */
export function isOutboxEventStatus(value: unknown): value is OutboxEventStatus {
  return (
    typeof value === 'string' &&
    (TERMINAL_OUTBOX_STATUSES as readonly string[]).includes(value) === false
      ? (NON_TERMINAL_OUTBOX_STATUSES as readonly string[]).includes(value)
      : (TERMINAL_OUTBOX_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * Allowed state transitions for the outbox lifecycle.
 *
 * Invariants enforced by {@link canTransitionOutboxStatus}:
 *  - `published` and `dead_letter` are terminal (no outgoing edges).
 *  - `processing` may only be entered from `pending` or `failed`.
 *  - A `processing` event may return to `pending` (lease reclaimed),
 *    `failed` (retryable error), `published` (success), or
 *    `dead_letter` (retries exhausted).
 *  - Self-transitions are rejected so that concurrent workers cannot
 *    both claim the same event and both believe they own it.
 */
const OUTBOX_STATUS_TRANSITIONS: Readonly<
  Record<OutboxEventStatus, readonly OutboxEventStatus[]>
> = {
  pending: ['processing'],
  processing: ['pending', 'failed', 'published', 'dead_letter'],
  failed: ['processing', 'dead_letter'],
  published: [],
  dead_letter: [],
}

/**
 * Returns true when transitioning from `from` to `to` is permitted.
 *
 * Deterministic for valid, invalid, duplicate, and boundary inputs:
 * unknown statuses and self-transitions return false.
 */
export function canTransitionOutboxStatus(
  from: OutboxEventStatus,
  to: OutboxEventStatus,
): boolean {
  if (from === to) return false
  const allowed = OUTBOX_STATUS_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * Returns true when the event has exhausted its retry budget.
 *
 * Boundary behavior: an event with `maxRetries <= 0` is considered
 * exhausted immediately, and `retryCount >= maxRetries` is exhausted.
 * Negative or non-finite counts are treated as exhausted so that a
 * corrupt row cannot loop forever.
 */
export function isOutboxRetryExhausted(event: {
  retryCount: number
  maxRetries: number
}): boolean {
  const { retryCount, maxRetries } = event
  if (!Number.isFinite(retryCount) || !Number.isFinite(maxRetries)) return true
  if (maxRetries <= 0) return true
  return retryCount >= maxRetries
}

/**
 * Returns true when a `processing` event's lease has expired and the
 * event may be safely reclaimed by another worker.
 *
 * A missing lease (`null`/`undefined`) is treated as expired so that
 * events orphaned by a crash before lease assignment are recoverable.
 * `now` is injected for deterministic tests.
 */
export function isOutboxLeaseExpired(
  event: { leaseExpiresAt?: Date | null },
  now: Date = new Date(),
): boolean {
  const lease = event.leaseExpiresAt
  if (!lease) return true
  const leaseMs = lease.getTime()
  if (!Number.isFinite(leaseMs)) return true
  return leaseMs <= now.getTime()
}

/**
 * Returns true when the event is eligible to be claimed for processing.
 *
 * Combines status, retry, and lease checks so that concurrent workers
 * cannot double-claim an event that is already being processed under a
 * live lease, and so that terminal events are never re-queued.
 */
export function isOutboxEventClaimable(
  event: {
    status: OutboxEventStatus
    retryCount: number
    maxRetries: number
    leaseExpiresAt?: Date | null
  },
  now: Date = new Date(),
): boolean {
  if (isTerminalOutboxStatus(event.status)) return false
  if (isOutboxRetryExhausted(event)) return false
  if (event.status === 'processing' && !isOutboxLeaseExpired(event, now)) {
    return false
  }
  return true
}

export type OutboxQuarantineReason =
  | 'malformed_json'
  | 'schema_invalid'
  | 'oversized_payload'
  | 'unknown_event_type'

/**
 * Reasons an outbox event may be recovered from a non-terminal state.
 * Kept as a closed union so callers cannot silently introduce new
 * recovery paths without updating downstream metrics and audit logs.
 */
export type OutboxRecoveryReason =
  | 'lease_expired'
  | 'stale_processing'
  | 'retry_exhausted'
  | 'manual_reinject'

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
  /**
   * Reason the entry was quarantined.  Mirrors `reason` but is nullable
   * for rows written before the reason column was introduced, so
   * recovery tooling can distinguish legacy rows from new ones.
   */
  recoveryReason?: OutboxRecoveryReason | null
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
  /**
   * Optional idempotency key supplied by the caller.  When present the
   * publisher will reuse it instead of generating a fresh one, which
   * lets callers safely retry event creation without duplicating
   * downstream side effects.
   */
  publishIdempotencyKey?: string | null
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
  /**
   * Delete dead-letter events older than this many days.  Defaults to
   * `failedRetentionDays` when omitted so existing callers keep their
   * current behavior while new callers can tune dead-letter retention
   * independently.
   */
  deadLetterRetentionDays?: number
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
