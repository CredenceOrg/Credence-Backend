/**
 * @module types/governance
 * @description Type definitions for the Credence governance arbitration log system.
 *
 * Arbitration logs form an **immutable audit trail** of the full dispute
 * lifecycle – from opening through evidence submission, voting, and final
 * outcome.  Every entry is append-only; once written it cannot be modified or
 * deleted, guaranteeing tamper-evident records for on-chain governance.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every event type that can appear in the arbitration
 * log.  New event types should be added here as the governance protocol
 * evolves.
 */
export enum ArbitrationEventType {
  /** A new dispute has been opened. */
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  /** Evidence (e.g. IPFS CID, URL) has been submitted. */
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  /** An arbitrator has cast a vote. */
  VOTE_CAST = 'VOTE_CAST',
  /** The dispute has been resolved with an outcome. */
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  /** The dispute has been escalated to a higher authority. */
  DISPUTE_ESCALATED = 'DISPUTE_ESCALATED',
}

/**
 * Possible outcomes once a dispute reaches resolution.
 */
export enum DisputeOutcome {
  /** Decided in favour of the claimant. */
  CLAIMANT_WINS = 'CLAIMANT_WINS',
  /** Decided in favour of the respondent. */
  RESPONDENT_WINS = 'RESPONDENT_WINS',
  /** Settled by mutual agreement / compromise. */
  SETTLED = 'SETTLED',
  /** Dismissed – insufficient evidence or invalid claim. */
  DISMISSED = 'DISMISSED',
}

/**
 * Vote direction for arbitrator votes.
 */
export enum VoteDirection {
  FOR_CLAIMANT = 'FOR_CLAIMANT',
  FOR_RESPONDENT = 'FOR_RESPONDENT',
  ABSTAIN = 'ABSTAIN',
}

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * Reference to a piece of evidence – could be an IPFS CID, an HTTP URL, or
 * an on-chain transaction hash.
 */
export interface EvidenceRef {
  /** Unique label / identifier for this piece of evidence. */
  label: string;
  /** URI or CID pointing to the evidence payload. */
  uri: string;
  /** SHA-256 hash of the evidence content (optional integrity check). */
  hash?: string;
}

/**
 * Metadata specific to a {@link ArbitrationEventType.DISPUTE_OPENED} event.
 */
export interface DisputeOpenedPayload {
  /** Address / DID of the claimant. */
  claimant: string;
  /** Address / DID of the respondent. */
  respondent: string;
  /** Human-readable reason for the dispute. */
  reason: string;
  /** Initial evidence submitted with the dispute. */
  evidenceRefs?: EvidenceRef[];
}

/**
 * Metadata specific to a {@link ArbitrationEventType.EVIDENCE_SUBMITTED} event.
 */
export interface EvidenceSubmittedPayload {
  /** The identity that submitted the evidence. */
  submittedBy: string;
  /** Evidence references being submitted. */
  evidenceRefs: EvidenceRef[];
}

/**
 * Metadata specific to a {@link ArbitrationEventType.VOTE_CAST} event.
 */
export interface VoteCastPayload {
  /** Address / DID of the voter (arbitrator). */
  voter: string;
  /** The direction of the vote. */
  direction: VoteDirection;
  /** Optional justification for the vote. */
  justification?: string;
}

/**
 * Metadata specific to a {@link ArbitrationEventType.DISPUTE_RESOLVED} event.
 */
export interface DisputeResolvedPayload {
  /** The final outcome. */
  outcome: DisputeOutcome;
  /** Summary / rationale written by the arbitration panel. */
  summary: string;
  /** Aggregated vote tally. */
  voteTally?: {
    forClaimant: number;
    forRespondent: number;
    abstain: number;
  };
}

/**
 * Metadata specific to a {@link ArbitrationEventType.DISPUTE_ESCALATED} event.
 */
export interface DisputeEscalatedPayload {
  /** Reason for escalation. */
  reason: string;
  /** Target authority / panel for escalation. */
  escalatedTo: string;
}

/**
 * Maps each event type to its corresponding payload interface for strict
 * type safety when creating log entries.
 */
export interface ArbitrationPayloadMap {
  [ArbitrationEventType.DISPUTE_OPENED]: DisputeOpenedPayload;
  [ArbitrationEventType.EVIDENCE_SUBMITTED]: EvidenceSubmittedPayload;
  [ArbitrationEventType.VOTE_CAST]: VoteCastPayload;
  [ArbitrationEventType.DISPUTE_RESOLVED]: DisputeResolvedPayload;
  [ArbitrationEventType.DISPUTE_ESCALATED]: DisputeEscalatedPayload;
}

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

/**
 * A single **immutable** arbitration log entry.
 *
 * Once persisted, none of the fields should ever be modified.  The
 * repository layer enforces this invariant.
 */
export interface ArbitrationLogEntry<
  T extends ArbitrationEventType = ArbitrationEventType,
> {
  /** Auto-generated unique identifier (UUID v4). */
  id: string;
  /** The dispute this entry belongs to. */
  disputeId: string;
  /** The type of governance event. */
  eventType: T;
  /** Event-specific payload. */
  payload: T extends keyof ArbitrationPayloadMap
    ? ArbitrationPayloadMap[T]
    : never;
  /** ISO-8601 timestamp of when the event was recorded. */
  timestamp: string;
  /** The identity that triggered this event. */
  actor: string;
  /** Monotonically increasing sequence number within the dispute. */
  sequenceNumber: number;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Supported query parameters for retrieving arbitration log entries.
 */
export interface ArbitrationLogQuery {
  /** Filter by dispute ID. */
  disputeId?: string;
  /** Filter by actor / identity address. */
  identity?: string;
  /** Filter by event type(s). */
  eventTypes?: ArbitrationEventType[];
  /** Return only entries **on or after** this ISO-8601 timestamp. */
  from?: string;
  /** Return only entries **on or before** this ISO-8601 timestamp. */
  to?: string;
  /** Maximum number of entries to return (default: 100). */
  limit?: number;
  /** Number of entries to skip for pagination (default: 0). */
  offset?: number;
}
