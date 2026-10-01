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
 * All quarantine reasons, useful for validation and exhaustive tests.
 */
export const OUTBOX_QUARANTINE_REASONS: readonly OutboxQuarantineReason[] = [
  'malformed_json',
  'schema_invalid',
  'oversized_payload',
  'unknown_event_type',
] as const

/**
 * Returns true when `value` is a valid {@link OutboxQuarantineReason}.
 */
export function isOutboxQuarantineReason(
  value: unknown,
): value is OutboxQuarantineReason {
  return (
    typeof value === 'string' &&
    (OUTBOX_QUARANTINE_REASONS as readonly string[]).includes(value)
  )
}

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
 * Default cleanup policy applied when a caller does not supply one.
 */
export const DEFAULT_OUTBOX_CLEANUP_CONFIG: OutboxCleanupConfig = {
  publishedRetentionDays: 7,
  failedRetentionDays: 30,
}

/**
 * Returns true when `value` is a usable {@link OutboxCleanupConfig}.
 *
 * Boundary behavior: retention days must be finite, non-negative
 * integers. Zero is allowed (delete immediately) but negative or
 * non-finite values are rejected so that a misconfigured cleanup job
 * cannot delete events that are still needed for recovery.
 */
export function isValidOutboxCleanupConfig(
  value: unknown,
): value is OutboxCleanupConfig {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OutboxCleanupConfig>
  return (
    isValidRetentionDays(candidate.publishedRetentionDays) &&
    isValidRetentionDays(candidate.failedRetentionDays)
  )
}

function isValidRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}
