/**
 * @file Tests for ArbitrationLogService.
 *
 * Covers:
 * - logDisputeOpened
 * - logEvidenceSubmitted
 * - logVoteCast
 * - logDisputeResolved
 * - logDisputeEscalated
 * - getEntryById
 * - query (delegation to repo)
 * - getDisputeTimeline
 * - totalEntries
 * - immutability of returned entries
 * - sequence numbering across events
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ArbitrationLogService } from '../../../src/services/governance/arbitrationLogs.js';
import { ArbitrationLogRepository } from '../../../src/repositories/arbitrationLogRepository.js';
import {
  ArbitrationEventType,
  DisputeOutcome,
  VoteDirection,
} from '../../../src/types/governance.js';
import type {
  DisputeOpenedPayload,
  EvidenceSubmittedPayload,
  VoteCastPayload,
  DisputeResolvedPayload,
  DisputeEscalatedPayload,
} from '../../../src/types/governance.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DISPUTE_ID = 'dispute-42';
const CLAIMANT = '0xClaimant';
const RESPONDENT = '0xRespondent';
const ARBITRATOR_A = '0xArbA';
const ARBITRATOR_B = '0xArbB';
const PANEL = '0xPanel';

const openPayload: DisputeOpenedPayload = {
  claimant: CLAIMANT,
  respondent: RESPONDENT,
  reason: 'False attestation on identity claim',
  evidenceRefs: [
    { label: 'tx-hash', uri: '0xabc123' },
    { label: 'ipfs-doc', uri: 'ipfs://QmXyz', hash: 'sha256:deadbeef' },
  ],
};

const evidencePayload: EvidenceSubmittedPayload = {
  submittedBy: RESPONDENT,
  evidenceRefs: [{ label: 'response-doc', uri: 'ipfs://QmResp' }],
};

const votePayloadA: VoteCastPayload = {
  voter: ARBITRATOR_A,
  direction: VoteDirection.FOR_CLAIMANT,
  justification: 'Evidence supports the claim',
};

const votePayloadB: VoteCastPayload = {
  voter: ARBITRATOR_B,
  direction: VoteDirection.FOR_RESPONDENT,
};

const resolvePayload: DisputeResolvedPayload = {
  outcome: DisputeOutcome.CLAIMANT_WINS,
  summary: 'Majority ruled in favour of the claimant.',
  voteTally: { forClaimant: 2, forRespondent: 1, abstain: 0 },
};

const escalatePayload: DisputeEscalatedPayload = {
  reason: 'Deadlock after initial vote',
  escalatedTo: PANEL,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArbitrationLogService', () => {
  let repo: ArbitrationLogRepository;
  let service: ArbitrationLogService;

  beforeEach(() => {
    repo = new ArbitrationLogRepository();
    service = new ArbitrationLogService(repo);
  });

  // -- logDisputeOpened ----------------------------------------------------

  describe('logDisputeOpened()', () => {
    it('should create a DISPUTE_OPENED entry', () => {
      const entry = service.logDisputeOpened(
        DISPUTE_ID,
        openPayload,
        CLAIMANT,
      );

      expect(entry.disputeId).toBe(DISPUTE_ID);
      expect(entry.eventType).toBe(ArbitrationEventType.DISPUTE_OPENED);
      expect(entry.actor).toBe(CLAIMANT);
      expect(entry.sequenceNumber).toBe(1);
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();

      // Payload is preserved
      const payload = entry.payload as DisputeOpenedPayload;
      expect(payload.claimant).toBe(CLAIMANT);
      expect(payload.respondent).toBe(RESPONDENT);
      expect(payload.reason).toBe(openPayload.reason);
      expect(payload.evidenceRefs).toHaveLength(2);
    });

    it('should be immutable', () => {
      const entry = service.logDisputeOpened(
        DISPUTE_ID,
        openPayload,
        CLAIMANT,
      );
      expect(Object.isFrozen(entry)).toBe(true);
    });
  });

  // -- logEvidenceSubmitted ------------------------------------------------

  describe('logEvidenceSubmitted()', () => {
    it('should create an EVIDENCE_SUBMITTED entry', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      const entry = service.logEvidenceSubmitted(
        DISPUTE_ID,
        evidencePayload,
        RESPONDENT,
      );

      expect(entry.eventType).toBe(
        ArbitrationEventType.EVIDENCE_SUBMITTED,
      );
      expect(entry.actor).toBe(RESPONDENT);
      expect(entry.sequenceNumber).toBe(2);

      const payload = entry.payload as EvidenceSubmittedPayload;
      expect(payload.submittedBy).toBe(RESPONDENT);
      expect(payload.evidenceRefs).toHaveLength(1);
    });
  });

  // -- logVoteCast ---------------------------------------------------------

  describe('logVoteCast()', () => {
    it('should create a VOTE_CAST entry with justification', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      const entry = service.logVoteCast(
        DISPUTE_ID,
        votePayloadA,
        ARBITRATOR_A,
      );

      expect(entry.eventType).toBe(ArbitrationEventType.VOTE_CAST);
      const payload = entry.payload as VoteCastPayload;
      expect(payload.voter).toBe(ARBITRATOR_A);
      expect(payload.direction).toBe(VoteDirection.FOR_CLAIMANT);
      expect(payload.justification).toBe(
        'Evidence supports the claim',
      );
    });

    it('should allow votes without justification', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      const entry = service.logVoteCast(
        DISPUTE_ID,
        votePayloadB,
        ARBITRATOR_B,
      );

      const payload = entry.payload as VoteCastPayload;
      expect(payload.justification).toBeUndefined();
    });
  });

  // -- logDisputeResolved --------------------------------------------------

  describe('logDisputeResolved()', () => {
    it('should create a DISPUTE_RESOLVED entry with tally', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      const entry = service.logDisputeResolved(
        DISPUTE_ID,
        resolvePayload,
        PANEL,
      );

      expect(entry.eventType).toBe(
        ArbitrationEventType.DISPUTE_RESOLVED,
      );
      const payload = entry.payload as DisputeResolvedPayload;
      expect(payload.outcome).toBe(DisputeOutcome.CLAIMANT_WINS);
      expect(payload.voteTally?.forClaimant).toBe(2);
    });
  });

  // -- logDisputeEscalated -------------------------------------------------

  describe('logDisputeEscalated()', () => {
    it('should create a DISPUTE_ESCALATED entry', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      const entry = service.logDisputeEscalated(
        DISPUTE_ID,
        escalatePayload,
        CLAIMANT,
      );

      expect(entry.eventType).toBe(
        ArbitrationEventType.DISPUTE_ESCALATED,
      );
      const payload = entry.payload as DisputeEscalatedPayload;
      expect(payload.escalatedTo).toBe(PANEL);
    });
  });

  // -- getEntryById --------------------------------------------------------

  describe('getEntryById()', () => {
    it('should retrieve an entry by id', () => {
      const created = service.logDisputeOpened(
        DISPUTE_ID,
        openPayload,
        CLAIMANT,
      );
      const found = service.getEntryById(created.id);
      expect(found).toEqual(created);
    });

    it('should return undefined for unknown id', () => {
      expect(service.getEntryById('nope')).toBeUndefined();
    });
  });

  // -- query ---------------------------------------------------------------

  describe('query()', () => {
    it('should delegate filtering to the repository', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);
      service.logDisputeOpened('other-dispute', openPayload, CLAIMANT);

      const results = service.query({ disputeId: DISPUTE_ID });
      expect(results).toHaveLength(2);
    });

    it('should filter by identity', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);

      const results = service.query({ identity: ARBITRATOR_A });
      expect(results).toHaveLength(1);
      expect(results[0].actor).toBe(ARBITRATOR_A);
    });

    it('should filter by event type', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);
      service.logVoteCast(DISPUTE_ID, votePayloadB, ARBITRATOR_B);

      const results = service.query({
        eventTypes: [ArbitrationEventType.VOTE_CAST],
      });
      expect(results).toHaveLength(2);
    });

    it('should return empty when nothing matches', () => {
      expect(
        service.query({ disputeId: 'nonexistent' }),
      ).toHaveLength(0);
    });
  });

  // -- getDisputeTimeline --------------------------------------------------

  describe('getDisputeTimeline()', () => {
    it('should return all events for a dispute in sequence order', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      service.logEvidenceSubmitted(
        DISPUTE_ID,
        evidencePayload,
        RESPONDENT,
      );
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);
      service.logVoteCast(DISPUTE_ID, votePayloadB, ARBITRATOR_B);
      service.logDisputeResolved(DISPUTE_ID, resolvePayload, PANEL);

      const timeline = service.getDisputeTimeline(DISPUTE_ID);
      expect(timeline).toHaveLength(5);

      // Verify ordering by sequenceNumber
      expect(timeline[0].eventType).toBe(
        ArbitrationEventType.DISPUTE_OPENED,
      );
      expect(timeline[1].eventType).toBe(
        ArbitrationEventType.EVIDENCE_SUBMITTED,
      );
      expect(timeline[2].eventType).toBe(
        ArbitrationEventType.VOTE_CAST,
      );
      expect(timeline[3].eventType).toBe(
        ArbitrationEventType.VOTE_CAST,
      );
      expect(timeline[4].eventType).toBe(
        ArbitrationEventType.DISPUTE_RESOLVED,
      );

      for (let i = 1; i < timeline.length; i++) {
        expect(timeline[i].sequenceNumber).toBeGreaterThan(
          timeline[i - 1].sequenceNumber,
        );
      }
    });

    it('should return empty array for unknown dispute', () => {
      expect(service.getDisputeTimeline('nope')).toEqual([]);
    });
  });

  // -- totalEntries --------------------------------------------------------

  describe('totalEntries', () => {
    it('should track the total number of log entries', () => {
      expect(service.totalEntries).toBe(0);
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      expect(service.totalEntries).toBe(1);
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);
      expect(service.totalEntries).toBe(2);
    });
  });

  // -- default repository --------------------------------------------------

  describe('default construction', () => {
    it('should work without injecting a repository', () => {
      const standalone = new ArbitrationLogService();
      const entry = standalone.logDisputeOpened(
        'd-new',
        openPayload,
        CLAIMANT,
      );
      expect(entry).toBeDefined();
      expect(standalone.totalEntries).toBe(1);
    });
  });

  // -- full lifecycle integration ------------------------------------------

  describe('full dispute lifecycle', () => {
    it('should correctly track a dispute from open to resolution', () => {
      // 1. Open
      const opened = service.logDisputeOpened(
        DISPUTE_ID,
        openPayload,
        CLAIMANT,
      );
      expect(opened.sequenceNumber).toBe(1);

      // 2. Evidence submitted by respondent
      const evidence = service.logEvidenceSubmitted(
        DISPUTE_ID,
        evidencePayload,
        RESPONDENT,
      );
      expect(evidence.sequenceNumber).toBe(2);

      // 3. Two arbitrator votes
      const vote1 = service.logVoteCast(
        DISPUTE_ID,
        votePayloadA,
        ARBITRATOR_A,
      );
      expect(vote1.sequenceNumber).toBe(3);

      const vote2 = service.logVoteCast(
        DISPUTE_ID,
        votePayloadB,
        ARBITRATOR_B,
      );
      expect(vote2.sequenceNumber).toBe(4);

      // 4. Resolution
      const resolved = service.logDisputeResolved(
        DISPUTE_ID,
        resolvePayload,
        PANEL,
      );
      expect(resolved.sequenceNumber).toBe(5);

      // Timeline check
      const timeline = service.getDisputeTimeline(DISPUTE_ID);
      expect(timeline).toHaveLength(5);

      // All entries persisted
      expect(service.totalEntries).toBe(5);

      // Query by identity
      const aliceEvents = service.query({ identity: CLAIMANT });
      expect(aliceEvents).toHaveLength(1);

      // Query by event type
      const votes = service.query({
        eventTypes: [ArbitrationEventType.VOTE_CAST],
      });
      expect(votes).toHaveLength(2);
    });
  });

  // -- escalation lifecycle ------------------------------------------------

  describe('escalation lifecycle', () => {
    it('should handle dispute escalation', () => {
      service.logDisputeOpened(DISPUTE_ID, openPayload, CLAIMANT);
      service.logVoteCast(DISPUTE_ID, votePayloadA, ARBITRATOR_A);
      service.logVoteCast(DISPUTE_ID, votePayloadB, ARBITRATOR_B);
      service.logDisputeEscalated(
        DISPUTE_ID,
        escalatePayload,
        CLAIMANT,
      );

      const timeline = service.getDisputeTimeline(DISPUTE_ID);
      expect(timeline).toHaveLength(4);
      expect(timeline[3].eventType).toBe(
        ArbitrationEventType.DISPUTE_ESCALATED,
      );
    });
  });
});
