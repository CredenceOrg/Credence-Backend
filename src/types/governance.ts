/**
 * @module types/governance
 * @description Core type definitions for the Credence governance system.
 *
 * Covers disputes, votes, arbitration logs, and multi-sig operations.
 * All types are intentionally narrow and exhaustive so that TypeScript
 * catches invalid state transitions at compile time wherever possible.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════════════════════════════════

/** Lifecycle states a dispute can be in. */
export enum DisputeStatus {
  OPEN = 'OPEN',
  EVIDENCE = 'EVIDENCE',
  VOTING = 'VOTING',
  RESOLVED = 'RESOLVED',
  EXPIRED = 'EXPIRED',
  ESCALATED = 'ESCALATED',
}

/** Outcome once a dispute reaches resolution. */
export enum DisputeOutcome {
  CLAIMANT_WINS = 'CLAIMANT_WINS',
  RESPONDENT_WINS = 'RESPONDENT_WINS',
  SETTLED = 'SETTLED',
  DISMISSED = 'DISMISSED',
}

/** Every event type that can appear in the arbitration log. */
export enum ArbitrationEventType {
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  VOTE_CAST = 'VOTE_CAST',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  DISPUTE_ESCALATED = 'DISPUTE_ESCALATED',
}

/** Direction an arbitrator can vote. */
export enum VoteDirection {
  FOR_CLAIMANT = 'FOR_CLAIMANT',
  FOR_RESPONDENT = 'FOR_RESPONDENT',
  ABSTAIN = 'ABSTAIN',
}

/** Lifecycle states for a multi-sig proposal. */
export enum MultiSigStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXECUTED = 'EXECUTED',
  EXPIRED = 'EXPIRED',
}

// ═══════════════════════════════════════════════════════════════════════════
// Evidence
// ═══════════════════════════════════════════════════════════════════════════

/** Reference to external evidence (IPFS CID, URL, tx hash, etc.). */
export interface EvidenceRef {
  label: string;
  uri: string;
  hash?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Disputes
// ═══════════════════════════════════════════════════════════════════════════

/** A governance dispute. */
export interface Dispute {
  id: string;
  claimant: string;
  respondent: string;
  reason: string;
  status: DisputeStatus;
  outcome?: DisputeOutcome;
  evidenceRefs: EvidenceRef[];
  /** ISO-8601 deadline after which the dispute expires if still OPEN/EVIDENCE. */
  deadline: string;
  createdAt: string;
  updatedAt: string;
}

/** Parameters for opening a new dispute. */
export interface CreateDisputeParams {
  claimant: string;
  respondent: string;
  reason: string;
  evidenceRefs?: EvidenceRef[];
  /** Deadline in ISO-8601. If omitted, defaults to 7 days from now. */
  deadline?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Votes
// ═══════════════════════════════════════════════════════════════════════════

/** A single arbitrator vote within a dispute. */
export interface Vote {
  id: string;
  disputeId: string;
  voter: string;
  direction: VoteDirection;
  justification?: string;
  timestamp: string;
}

/** Aggregated vote tally for a dispute. */
export interface VoteTally {
  forClaimant: number;
  forRespondent: number;
  abstain: number;
  total: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Arbitration Log
// ═══════════════════════════════════════════════════════════════════════════

/** A single immutable arbitration log entry. */
export interface ArbitrationLogEntry {
  id: string;
  disputeId: string;
  eventType: ArbitrationEventType;
  payload: Record<string, unknown>;
  timestamp: string;
  actor: string;
  sequenceNumber: number;
}

/** Query parameters for arbitration log retrieval. */
export interface ArbitrationLogQuery {
  disputeId?: string;
  identity?: string;
  eventTypes?: ArbitrationEventType[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-sig
// ═══════════════════════════════════════════════════════════════════════════

/** A multi-sig governance proposal. */
export interface MultiSigProposal {
  id: string;
  title: string;
  description: string;
  proposer: string;
  status: MultiSigStatus;
  /** Addresses whose signatures are required. */
  signers: string[];
  /** Addresses that have signed so far. */
  signatures: string[];
  /** Minimum signatures needed for approval. */
  threshold: number;
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 deadline for collecting signatures. */
  deadline: string;
}

/** Parameters for creating a multi-sig proposal. */
export interface CreateMultiSigParams {
  title: string;
  description: string;
  proposer: string;
  signers: string[];
  threshold: number;
  /** Deadline in ISO-8601. If omitted, defaults to 7 days from now. */
  deadline?: string;
}
