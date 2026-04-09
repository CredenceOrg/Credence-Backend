/**
 * @module listeners/attestationEvents
 * @description Polls Horizon for attestation events (add/revoke) emitted by the
 * Credence contract and syncs them to the local attestation store.
 *
 * The listener uses cursor-based pagination so it can resume from where it left
 * off after restarts, and exposes lifecycle methods (`start` / `stop`) plus a
 * `getStats()` introspection helper.
 *
 * On each ingested event the listener:
 *  - **add**: upserts the attestation and links it to the subject identity
 *  - **revoke**: marks the attestation as revoked (idempotent)
 *
 * After processing a batch it invokes an optional `onScoreInvalidation` callback
 * so callers can trigger score recalculation or cache invalidation.
 */

import type { Attestation, CreateAttestationParams } from '../types/attestation.js'
import type { IdempotencyGuard } from '../lib/idempotencyGuard.js'

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Shape of an on-chain attestation event as parsed from a Horizon operation. */
export interface AttestationEvent {
  /** Unique event identifier (e.g. Horizon operation ID). */
  id: string
  /** Paging token for cursor-based resumption. */
  pagingToken: string
  /** `"add"` or `"revoke"`. */
  type: 'add' | 'revoke'
  /** Stellar address of the subject (identity being attested). */
  subject: string
  /** Stellar address of the verifier (who issued the attestation). */
  verifier: string
  /** Numeric weight / confidence (0–100). Only meaningful for `add`. */
  weight: number
  /** Free-form claim string. Only meaningful for `add`. */
  claim: string
  /** ISO-8601 timestamp of when the event was created on-chain. */
  createdAt: string
  /** Transaction hash that included this event. */
  transactionHash: string
}

/** Minimal interface for the attestation data store. */
export interface AttestationStore {
  /** Persist a new attestation. */
  create(params: CreateAttestationParams): Attestation
  /** Find an attestation by its ID. */
  findById(id: string): Attestation | undefined
  /** Find attestations for a subject. */
  findBySubject(
    subject: string,
    opts?: { includeRevoked?: boolean; page?: number; limit?: number },
  ): { attestations: Attestation[]; total: number }
  /** Revoke an attestation. Returns the updated record or undefined. */
  revoke(id: string): Attestation | undefined
}

/** Callback invoked with addresses whose scores may need recalculation. */
export type ScoreInvalidationCallback = (addresses: string[]) => void | Promise<void>

/** Configuration for the attestation event listener. */
export interface AttestationListenerConfig {
  /** Polling interval in milliseconds (default 5 000). */
  pollingInterval?: number
  /** Cursor to resume from (default `"now"`). */
  lastCursor?: string
  /** Optional idempotency guard for preventing duplicate processing. */
  idempotencyGuard?: IdempotencyGuard
}

/** Runtime statistics exposed by `getStats()`. */
export interface AttestationListenerStats {
  isRunning: boolean
  lastCursor: string
  eventsProcessed: number
  addEvents: number
  revokeEvents: number
  duplicatesSkipped: number
  errors: number
  lastPollAt: string | null
}

// ═══════════════════════════════════════════════════════════════════════════
// Listener implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch attestation events from Horizon.
 *
 * This is the **only** function that touches the network and is designed to be
 * easily replaced or mocked in tests.
 */
export type EventFetcher = (cursor: string) => Promise<AttestationEvent[]>

/**
 * Attestation event listener that polls for on-chain attestation events and
 * syncs them to the local store.
 *
 * @example
 * ```ts
 * const listener = new AttestationEventListener(
 *   store,
 *   fetchEvents,
 *   { pollingInterval: 5_000 },
 *   (addresses) => scoreService.invalidate(addresses),
 * )
 * await listener.start()
 * ```
 */
export class AttestationEventListener {
  private isRunning = false
  private pollTimer?: ReturnType<typeof setTimeout>
  private lastCursor: string
  private readonly pollingInterval: number
  private readonly idempotencyGuard?: IdempotencyGuard

  // Stats
  private eventsProcessed = 0
  private addEvents = 0
  private revokeEvents = 0
  private duplicatesSkipped = 0
  private errors = 0
  private lastPollAt: string | null = null

  /**
   * Map from on-chain event ID → local attestation ID.
   * Used for deduplication and to resolve revocations to the correct record.
   */
  private readonly eventIdToAttestationId = new Map<string, string>()

  constructor(
    private readonly store: AttestationStore,
    private readonly fetchEvents: EventFetcher,
    private readonly replayService: { captureFailure: (type: string, data: any, reason: string) => Promise<any> },
    config: AttestationListenerConfig = {},
    private readonly onScoreInvalidation?: ScoreInvalidationCallback,
  ) {
    this.pollingInterval = config.pollingInterval ?? 5_000
    this.lastCursor = config.lastCursor ?? 'now'
    this.idempotencyGuard = config.idempotencyGuard
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Start polling for attestation events. */
  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    await this.poll()
  }

  /** Stop polling. */
  stop(): void {
    this.isRunning = false
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /** Whether the listener is currently active. */
  isActive(): boolean {
    return this.isRunning
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.isRunning) return

    try {
      this.lastPollAt = new Date().toISOString()
      const events = await this.fetchEvents(this.lastCursor)
      const affectedAddresses = new Set<string>()

      for (const event of events) {
        try {
          const affected = await this.processEvent(event)
          if (affected) affectedAddresses.add(affected)
          this.lastCursor = event.pagingToken
        } catch (error: any) {
          this.errors += 1
          // Capture failure for replay
          await this.replayService.captureFailure('attestation', event, error.message)
        }
      }

      // Trigger score invalidation for all affected identities
      if (affectedAddresses.size > 0 && this.onScoreInvalidation) {
        try {
          await this.onScoreInvalidation([...affectedAddresses])
        } catch {
          // Score invalidation failure should not stop ingestion
        }
      }
    } catch {
      this.errors += 1
    }

    // Schedule next poll
    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this.poll(), this.pollingInterval)
    }
  }

  // ── Event processing ─────────────────────────────────────────────────

  /**
   * Process a single attestation event.
   * @returns The subject address if the event was processed, or `null` if skipped.
   */
  async processEvent(event: AttestationEvent): Promise<string | null> {
    if (event.type === 'add') {
      return await this.handleAddEvent(event)
    } else if (event.type === 'revoke') {
      return await this.handleRevokeEvent(event)
    }
    return null
  }

  private async handleAddEvent(event: AttestationEvent): Promise<string | null> {
    // In-memory deduplication (fast path)
    if (this.eventIdToAttestationId.has(event.id)) {
      this.duplicatesSkipped += 1
      return null
    }

    // Persistent idempotency guard (survives restarts)
    if (this.idempotencyGuard) {
      const result = await this.idempotencyGuard.process(
        'attestation:add',
        event.id,
        async () => {
          const attestation = this.store.create({
            subject: event.subject,
            verifier: event.verifier,
            weight: event.weight,
            claim: event.claim,
          })
          return { attestation, subject: event.subject }
        }
      )

      if (!result.executed) {
        this.duplicatesSkipped += 1
        return null
      }

      this.eventIdToAttestationId.set(event.id, result.value!.attestation.id)
      this.eventsProcessed += 1
      this.addEvents += 1
      return result.value!.subject
    }

    // Fallback: no idempotency guard (legacy behavior)
    const attestation = this.store.create({
      subject: event.subject,
      verifier: event.verifier,
      weight: event.weight,
      claim: event.claim,
    })

    this.eventIdToAttestationId.set(event.id, attestation.id)
    this.eventsProcessed += 1
    this.addEvents += 1
    return event.subject
  }

  private async handleRevokeEvent(event: AttestationEvent): Promise<string | null> {
    // In-memory deduplication (fast path)
    if (this.eventIdToAttestationId.has(event.id)) {
      this.duplicatesSkipped += 1
      return null
    }

    // Persistent idempotency guard (survives restarts)
    if (this.idempotencyGuard) {
      const result = await this.idempotencyGuard.process(
        'attestation:revoke',
        event.id,
        async () => {
          // Find the attestation to revoke
          const { attestations } = this.store.findBySubject(event.subject, {
            includeRevoked: false,
          })

          const target = attestations.find((a) => a.verifier === event.verifier)

          if (target) {
            try {
              this.store.revoke(target.id)
            } catch {
              // Already revoked — idempotent
            }
          }

          return { targetId: target?.id ?? event.id, subject: event.subject }
        }
      )

      if (!result.executed) {
        this.duplicatesSkipped += 1
        return null
      }

      this.eventIdToAttestationId.set(event.id, result.value!.targetId)
      this.eventsProcessed += 1
      this.revokeEvents += 1
      return result.value!.subject
    }

    // Fallback: no idempotency guard (legacy behavior)
    const { attestations } = this.store.findBySubject(event.subject, {
      includeRevoked: false,
    })

    const target = attestations.find((a) => a.verifier === event.verifier)

    if (target) {
      try {
        this.store.revoke(target.id)
      } catch {
        // Already revoked — idempotent
        this.duplicatesSkipped += 1
        return null
      }
    }

    this.eventIdToAttestationId.set(event.id, target?.id ?? event.id)
    this.eventsProcessed += 1
    this.revokeEvents += 1
    return event.subject
  }

  // ── Introspection ────────────────────────────────────────────────────

  /** Return current listener statistics. */
  getStats(): AttestationListenerStats {
    return {
      isRunning: this.isRunning,
      lastCursor: this.lastCursor,
      eventsProcessed: this.eventsProcessed,
      addEvents: this.addEvents,
      revokeEvents: this.revokeEvents,
      duplicatesSkipped: this.duplicatesSkipped,
      errors: this.errors,
      lastPollAt: this.lastPollAt,
    }
  }

  /** Update the cursor (e.g. after external sync). */
  setCursor(cursor: string): void {
    this.lastCursor = cursor
  }
}
