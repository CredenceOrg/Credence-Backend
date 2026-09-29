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
 * Canonical terminal states for an outbox event. Once an event reaches
 * one of these states it must not be processed again by the worker.
 */
export const TERMINAL_OUTBOX_STATUSES: readonly OutboxEventStatus[] = [
  'published',
  'dead_letter',
] as const

/**
 * States from which the worker may claim an event for processing.
 * Lease expiry is handled separately via canReclaimExpiredLease.
 */
export const CLAIMABLE_OUTBOX_STATUSES: readonly OutboxEventStatus[] = [
  'pending',
  'failed',
] as const

/**
 * Maximum allowed value for `maxRetries`. Guards against accidental
 * configuration that would cause unbounded retry loops.
 */
export const MAX_RETRIES_LIMIT = 100

/**
 * Default number of retries applied when `CreateOutboxEvent.maxRetries`
 * is not provided.
 */
export const DEFAULT_MAX_RETRIES = 5

export type OutboxEventTransitionResult =
  | { ok: true; status: OutboxEventStatus }
  | { ok: false; reason: OutboxTransitionRejectionReason }

export type OutboxTransitionRejectionReason =
  | 'terminal_state'
  | 'invalid_transition'
  | 'retries_exhausted'
  | 'not_owned'
  | 'lease_expired'

/**
 * Allowed state transitions for the outbox worker. This is the
 * authoritative state machine; the worker must not attempt transitions
 * outside of this map. Keys are the current state, values are the
 * permitted next states.
 */
export const ALLOWED_OUTBOX_TRANSITIONS: Readonly<Record<OutboxEventStatus, readonly OutboxEventStatus[]>> = {
  pending: ['processing', 'dead_letter'],
  processing: ['published', 'failed', 'pending', 'dead_letter'],
  failed: ['processing', 'dead_letter'],
  published: [],
  dead_letter: [],
} as const

export function isTerminalOutboxStatus(status: OutboxEventStatus): boolean {
  return TERMINAL_OUTBOX_STATUSES.includes(status)
}

export function isClaimableOutboxStatus(status: OutboxEventStatus): boolean {
  return CLAIMABLE_OUTBOX_STATUSES.includes(status)
}

export function canTransitionOutboxStatus(
  from: OutboxEventStatus,
  to: OutboxEventStatus,
): boolean {
  return ALLOWED_OUTBOX_TRANSITIONS[from].includes(to)
}

/**
 * Returns true when an event in `processing` state can be re-claimed
 * because its lease has expired. A null/undefined lease expiry is
 * treated as expired to avoid a permanently stuck event.
 */
export function canReclaimExpiredLease(
  event: Pick<OutboxEvent, 'status' | 'leaseExpiresAt'>,
  now: Date = new Date(),
): boolean {
  if (event.status !== 'processing') return false
  if (!event.leaseExpiresAt) return true
  return event.leaseExpiresAt.getTime() <= now.getTime()
}

/**
 * Decides the next status for a failed attempt. Returns `failed` when
 * retries remain, otherwise `dead_letter`. This is the single source
 * of truth for retry exhaustion so the worker and tests agree.
 */
export function resolveOutboxFailureStatus(
  event: Pick<OutboxEvent, 'retryCount' | 'maxRetries'>,
  increment: number = 1,
): OutboxEventStatus {
  const nextRetryCount = event.retryCount + increment
  return nextRetryCount >= event.maxRetries ? 'dead_letter' : 'failed'
}

export function validateOutboxEventInput(input: CreateOutboxEvent): void {
  if (!input.aggregateType || input.aggregateType.trim().length === 0) {
    throw new Error('aggregateType is required')
  }
  if (!input.aggregateId || input.aggregateId.trim().length === 0) {
    throw new Error('aggregateId is required')
  }
  if (!input.eventType || input.eventType.trim().length === 0) {
    throw new Error('eventType is required')
  }
  if (input.maxRetries !== undefined) {
    if (!Number.isInteger(input.maxRetries) || input.maxRetries < 1) {
      throw new Error('maxRetries must be a positive integer')
    }
    if (input.maxRetries > MAX_RETRIES_LIMIT) {
      throw new Error(`maxRetries must not exceed ${MAX_RETRIES_LIMIT}`)
    }
  }
}
