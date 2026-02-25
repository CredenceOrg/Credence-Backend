/**
 * @module services/governance/arbitrationLogs
 * @description Service layer for the Credence arbitration log system.
 *
 * This service owns all business logic around the dispute lifecycle:
 *
 * 1. **Opening** a dispute (`logDisputeOpened`)
 * 2. **Submitting evidence** (`logEvidenceSubmitted`)
 * 3. **Casting votes** (`logVoteCast`)
 * 4. **Resolving** a dispute (`logDisputeResolved`)
 * 5. **Escalating** a dispute (`logDisputeEscalated`)
 * 6. **Querying** the immutable audit trail (`query`, `getDisputeTimeline`)
 *
 * Every write creates an immutable {@link ArbitrationLogEntry} in the
 * underlying repository.  Callers interact exclusively through this
 * service rather than touching the repository directly.
 */

import { randomUUID } from 'node:crypto';

import { ArbitrationLogRepository } from '../../repositories/arbitrationLogRepository.js';
import type {
  ArbitrationLogEntry,
  ArbitrationLogQuery,
  DisputeOpenedPayload,
  DisputeResolvedPayload,
  DisputeEscalatedPayload,
  EvidenceSubmittedPayload,
  VoteCastPayload,
} from '../../types/governance.js';
import { ArbitrationEventType } from '../../types/governance.js';

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * High-level service for recording and querying arbitration log entries.
 *
 * @example
 * ```ts
 * const service = new ArbitrationLogService();
 *
 * const entry = service.logDisputeOpened('d-1', {
 *   claimant: '0xAAA',
 *   respondent: '0xBBB',
 *   reason: 'False attestation',
 * }, '0xAAA');
 *
 * const timeline = service.getDisputeTimeline('d-1');
 * ```
 */
export class ArbitrationLogService {
  /** The backing repository. */
  private readonly repository: ArbitrationLogRepository;

  /**
   * @param repository - Optional repository instance (useful for DI / testing).
   *                     Defaults to a fresh in-memory repository.
   */
  constructor(repository?: ArbitrationLogRepository) {
    this.repository = repository ?? new ArbitrationLogRepository();
  }

  // -----------------------------------------------------------------------
  // Write helpers (one per event type)
  // -----------------------------------------------------------------------

  /**
   * Record the opening of a new dispute.
   *
   * @param disputeId - Unique dispute identifier.
   * @param payload   - Dispute details (claimant, respondent, reason, etc.).
   * @param actor     - The identity that opened the dispute.
   * @returns The persisted log entry.
   */
  logDisputeOpened(
    disputeId: string,
    payload: DisputeOpenedPayload,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    return this.appendEntry(
      disputeId,
      ArbitrationEventType.DISPUTE_OPENED,
      payload,
      actor,
    );
  }

  /**
   * Record the submission of evidence to a dispute.
   *
   * @param disputeId - Dispute identifier.
   * @param payload   - Evidence details.
   * @param actor     - The identity that submitted the evidence.
   * @returns The persisted log entry.
   */
  logEvidenceSubmitted(
    disputeId: string,
    payload: EvidenceSubmittedPayload,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    return this.appendEntry(
      disputeId,
      ArbitrationEventType.EVIDENCE_SUBMITTED,
      payload,
      actor,
    );
  }

  /**
   * Record a vote cast by an arbitrator.
   *
   * @param disputeId - Dispute identifier.
   * @param payload   - Vote details (voter, direction, justification).
   * @param actor     - The identity that cast the vote.
   * @returns The persisted log entry.
   */
  logVoteCast(
    disputeId: string,
    payload: VoteCastPayload,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    return this.appendEntry(
      disputeId,
      ArbitrationEventType.VOTE_CAST,
      payload,
      actor,
    );
  }

  /**
   * Record the resolution of a dispute.
   *
   * @param disputeId - Dispute identifier.
   * @param payload   - Outcome details (outcome, summary, vote tally).
   * @param actor     - The identity that recorded the resolution.
   * @returns The persisted log entry.
   */
  logDisputeResolved(
    disputeId: string,
    payload: DisputeResolvedPayload,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    return this.appendEntry(
      disputeId,
      ArbitrationEventType.DISPUTE_RESOLVED,
      payload,
      actor,
    );
  }

  /**
   * Record the escalation of a dispute.
   *
   * @param disputeId - Dispute identifier.
   * @param payload   - Escalation reason and target authority.
   * @param actor     - The identity that triggered the escalation.
   * @returns The persisted log entry.
   */
  logDisputeEscalated(
    disputeId: string,
    payload: DisputeEscalatedPayload,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    return this.appendEntry(
      disputeId,
      ArbitrationEventType.DISPUTE_ESCALATED,
      payload,
      actor,
    );
  }

  // -----------------------------------------------------------------------
  // Reads / queries
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single log entry by its unique ID.
   *
   * @param id - Entry UUID.
   * @returns The entry, or `undefined` if not found.
   */
  getEntryById(id: string): Readonly<ArbitrationLogEntry> | undefined {
    return this.repository.findById(id);
  }

  /**
   * Query log entries with flexible filters and pagination.
   *
   * @param query - Filter / pagination parameters.
   * @returns Matching entries ordered by timestamp ascending.
   */
  query(
    query: ArbitrationLogQuery = {},
  ): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    return this.repository.query(query);
  }

  /**
   * Return the complete ordered timeline of a dispute – all events sorted
   * by their sequence number.
   *
   * @param disputeId - The dispute to look up.
   * @returns Ordered array of log entries.
   */
  getDisputeTimeline(
    disputeId: string,
  ): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    return this.repository.findByDisputeId(disputeId);
  }

  /**
   * Total number of log entries in the store.
   */
  get totalEntries(): number {
    return this.repository.size;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Construct, freeze, and persist a new log entry.
   *
   * @internal
   */
  private appendEntry(
    disputeId: string,
    eventType: ArbitrationEventType,
    payload: Record<string, unknown>,
    actor: string,
  ): Readonly<ArbitrationLogEntry> {
    const entry: ArbitrationLogEntry = {
      id: randomUUID(),
      disputeId,
      eventType,
      payload: payload as ArbitrationLogEntry['payload'],
      timestamp: new Date().toISOString(),
      actor,
      sequenceNumber: this.repository.nextSequenceNumber(disputeId),
    };

    return this.repository.append(entry);
  }
}
