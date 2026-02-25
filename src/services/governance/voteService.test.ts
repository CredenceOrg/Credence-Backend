/**
 * @file Unit tests for VoteService.
 *
 * Test scenarios:
 * ─ Casting: valid vote, missing fields, invalid direction, duplicate voter
 * ─ Read: getByDispute, getByVoter
 * ─ Tally: counting, threshold met/not-met, tie-breaking, all-abstain
 * ─ Helpers: size, clear
 * ─ Integration: multi-voter flow
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { VoteService } from './voteService.js';
import { VoteDirection } from '../../types/governance.js';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('VoteService', () => {
  let svc: VoteService;

  beforeEach(() => {
    svc = new VoteService();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Casting
  // ══════════════════════════════════════════════════════════════════════

  describe('cast()', () => {
    it('should create a vote with valid params', () => {
      const v = svc.cast({
        disputeId: 'd-1',
        voter: '0xArb1',
        direction: VoteDirection.FOR_CLAIMANT,
        justification: 'Strong evidence',
      });

      expect(v.id).toBeTruthy();
      expect(v.disputeId).toBe('d-1');
      expect(v.voter).toBe('0xArb1');
      expect(v.direction).toBe(VoteDirection.FOR_CLAIMANT);
      expect(v.justification).toBe('Strong evidence');
      expect(v.timestamp).toBeTruthy();
    });

    it('should allow vote without justification', () => {
      const v = svc.cast({
        disputeId: 'd-1',
        voter: '0xArb1',
        direction: VoteDirection.FOR_RESPONDENT,
      });
      expect(v.justification).toBeUndefined();
    });

    it('should allow ABSTAIN direction', () => {
      const v = svc.cast({
        disputeId: 'd-1',
        voter: '0xArb1',
        direction: VoteDirection.ABSTAIN,
      });
      expect(v.direction).toBe(VoteDirection.ABSTAIN);
    });

    // ── Validation ──────────────────────────────────────────────────────

    it('should throw if disputeId is empty', () => {
      expect(() =>
        svc.cast({ disputeId: '', voter: '0xA', direction: VoteDirection.ABSTAIN }),
      ).toThrow('disputeId is required');
    });

    it('should throw if voter is empty', () => {
      expect(() =>
        svc.cast({ disputeId: 'd-1', voter: '', direction: VoteDirection.ABSTAIN }),
      ).toThrow('voter is required');
    });

    it('should throw if direction is invalid', () => {
      expect(() =>
        svc.cast({
          disputeId: 'd-1',
          voter: '0xA',
          direction: 'INVALID' as VoteDirection,
        }),
      ).toThrow('Invalid vote direction');
    });

    it('should throw if voter already voted on the same dispute', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_CLAIMANT });
      expect(() =>
        svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_RESPONDENT }),
      ).toThrow('already voted');
    });

    it('should allow the same voter to vote on different disputes', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_CLAIMANT });
      const v = svc.cast({ disputeId: 'd-2', voter: '0xArb1', direction: VoteDirection.FOR_RESPONDENT });
      expect(v.disputeId).toBe('d-2');
    });

    it('should return a defensive copy', () => {
      const v = svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_CLAIMANT });
      v.voter = 'hacked';
      const votes = svc.getByDispute('d-1');
      expect(votes[0].voter).toBe('0xArb1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Read
  // ══════════════════════════════════════════════════════════════════════

  describe('getByDispute()', () => {
    it('should return votes for a given dispute', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_RESPONDENT });
      svc.cast({ disputeId: 'd-2', voter: '0xC', direction: VoteDirection.ABSTAIN });

      const votes = svc.getByDispute('d-1');
      expect(votes).toHaveLength(2);
      votes.forEach((v) => expect(v.disputeId).toBe('d-1'));
    });

    it('should return empty array for unknown dispute', () => {
      expect(svc.getByDispute('nope')).toEqual([]);
    });
  });

  describe('getByVoter()', () => {
    it('should return all votes cast by a voter', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-2', voter: '0xArb1', direction: VoteDirection.ABSTAIN });
      svc.cast({ disputeId: 'd-1', voter: '0xArb2', direction: VoteDirection.FOR_RESPONDENT });

      const votes = svc.getByVoter('0xArb1');
      expect(votes).toHaveLength(2);
      votes.forEach((v) => expect(v.voter).toBe('0xArb1'));
    });

    it('should return empty array for unknown voter', () => {
      expect(svc.getByVoter('nobody')).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tally & Threshold
  // ══════════════════════════════════════════════════════════════════════

  describe('computeTally()', () => {
    it('should tally votes correctly', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xC', direction: VoteDirection.FOR_RESPONDENT });
      svc.cast({ disputeId: 'd-1', voter: '0xD', direction: VoteDirection.ABSTAIN });

      const { tally } = svc.computeTally('d-1', 2);
      expect(tally.forClaimant).toBe(2);
      expect(tally.forRespondent).toBe(1);
      expect(tally.abstain).toBe(1);
      expect(tally.total).toBe(4);
    });

    it('should report hasMet = true when threshold is reached', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_CLAIMANT });

      const { hasMet } = svc.computeTally('d-1', 2);
      expect(hasMet).toBe(true);
    });

    it('should report hasMet = false when threshold is not reached', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });

      const { hasMet } = svc.computeTally('d-1', 2);
      expect(hasMet).toBe(false);
    });

    it('should identify leading direction (FOR_CLAIMANT)', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xC', direction: VoteDirection.FOR_RESPONDENT });

      const { leadingDirection } = svc.computeTally('d-1', 2);
      expect(leadingDirection).toBe(VoteDirection.FOR_CLAIMANT);
    });

    it('should identify leading direction (FOR_RESPONDENT)', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_RESPONDENT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_RESPONDENT });
      svc.cast({ disputeId: 'd-1', voter: '0xC', direction: VoteDirection.FOR_CLAIMANT });

      const { leadingDirection } = svc.computeTally('d-1', 2);
      expect(leadingDirection).toBe(VoteDirection.FOR_RESPONDENT);
    });

    it('should favour FOR_CLAIMANT on a tie', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.FOR_RESPONDENT });

      const { leadingDirection } = svc.computeTally('d-1', 1);
      expect(leadingDirection).toBe(VoteDirection.FOR_CLAIMANT);
    });

    it('should return null leadingDirection when all abstain', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.ABSTAIN });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.ABSTAIN });

      const { leadingDirection, hasMet } = svc.computeTally('d-1', 1);
      expect(leadingDirection).toBeNull();
      expect(hasMet).toBe(false);
    });

    it('should return null leadingDirection when no votes exist', () => {
      const { leadingDirection, tally, hasMet } = svc.computeTally('d-1', 1);
      expect(leadingDirection).toBeNull();
      expect(tally.total).toBe(0);
      expect(hasMet).toBe(false);
    });

    it('should check threshold based on leading non-abstain direction', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.FOR_CLAIMANT });
      svc.cast({ disputeId: 'd-1', voter: '0xB', direction: VoteDirection.ABSTAIN });
      svc.cast({ disputeId: 'd-1', voter: '0xC', direction: VoteDirection.ABSTAIN });

      // Only 1 FOR_CLAIMANT, threshold is 2
      const { hasMet } = svc.computeTally('d-1', 2);
      expect(hasMet).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════

  describe('size / clear()', () => {
    it('should report correct size', () => {
      expect(svc.size).toBe(0);
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.ABSTAIN });
      expect(svc.size).toBe(1);
    });

    it('should clear all votes', () => {
      svc.cast({ disputeId: 'd-1', voter: '0xA', direction: VoteDirection.ABSTAIN });
      svc.clear();
      expect(svc.size).toBe(0);
      expect(svc.getByDispute('d-1')).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Integration: multi-voter flow
  // ══════════════════════════════════════════════════════════════════════

  describe('multi-voter flow', () => {
    it('should handle a realistic 5-arbitrator panel', () => {
      const disputeId = 'd-panel';
      const voters = ['0xArb1', '0xArb2', '0xArb3', '0xArb4', '0xArb5'];
      const directions = [
        VoteDirection.FOR_CLAIMANT,
        VoteDirection.FOR_CLAIMANT,
        VoteDirection.FOR_RESPONDENT,
        VoteDirection.FOR_CLAIMANT,
        VoteDirection.ABSTAIN,
      ];

      voters.forEach((voter, i) => {
        svc.cast({ disputeId, voter, direction: directions[i] });
      });

      expect(svc.getByDispute(disputeId)).toHaveLength(5);

      const { tally, hasMet, leadingDirection } = svc.computeTally(
        disputeId,
        3,
      );
      expect(tally.forClaimant).toBe(3);
      expect(tally.forRespondent).toBe(1);
      expect(tally.abstain).toBe(1);
      expect(tally.total).toBe(5);
      expect(hasMet).toBe(true);
      expect(leadingDirection).toBe(VoteDirection.FOR_CLAIMANT);
    });
  });
});
