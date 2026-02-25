/**
 * @file Unit tests for DisputeService.
 *
 * Test scenarios:
 * ─ Creation: valid params, missing/empty fields, same-party, past deadline
 * ─ Read: getById, list
 * ─ Status transitions: every valid and invalid path
 * ─ Resolution: resolve from VOTING, reject from other statuses
 * ─ Evidence: add in OPEN/EVIDENCE, reject in others
 * ─ Deadline: isExpired, expireOverdue
 * ─ Helpers: size, clear
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { DisputeService } from './disputeService.js';
import { DisputeStatus, DisputeOutcome } from '../../types/governance.js';
import type { CreateDisputeParams } from '../../types/governance.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function futureDate(days = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function pastDate(days = 1): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function validParams(overrides: Partial<CreateDisputeParams> = {}): CreateDisputeParams {
  return {
    claimant: '0xClaimant',
    respondent: '0xRespondent',
    reason: 'Fraudulent attestation',
    deadline: futureDate(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DisputeService', () => {
  let svc: DisputeService;

  beforeEach(() => {
    svc = new DisputeService();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Creation
  // ══════════════════════════════════════════════════════════════════════

  describe('create()', () => {
    it('should create a dispute with valid params', () => {
      const d = svc.create(validParams());
      expect(d.id).toBeTruthy();
      expect(d.claimant).toBe('0xClaimant');
      expect(d.respondent).toBe('0xRespondent');
      expect(d.reason).toBe('Fraudulent attestation');
      expect(d.status).toBe(DisputeStatus.OPEN);
      expect(d.outcome).toBeUndefined();
      expect(d.evidenceRefs).toEqual([]);
      expect(d.createdAt).toBeTruthy();
      expect(d.updatedAt).toBeTruthy();
    });

    it('should accept initial evidence refs', () => {
      const refs = [{ label: 'doc', uri: 'ipfs://Qm1' }];
      const d = svc.create(validParams({ evidenceRefs: refs }));
      expect(d.evidenceRefs).toHaveLength(1);
      expect(d.evidenceRefs[0].label).toBe('doc');
    });

    it('should apply a default 7-day deadline when omitted', () => {
      const d = svc.create(validParams({ deadline: undefined }));
      const dl = new Date(d.deadline);
      const now = new Date();
      const diffDays = (dl.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThanOrEqual(7.01);
    });

    // ── Validation failures ─────────────────────────────────────────────

    it('should throw if claimant is empty', () => {
      expect(() => svc.create(validParams({ claimant: '' }))).toThrow(
        'claimant is required',
      );
    });

    it('should throw if claimant is only whitespace', () => {
      expect(() => svc.create(validParams({ claimant: '   ' }))).toThrow(
        'claimant is required',
      );
    });

    it('should throw if respondent is empty', () => {
      expect(() => svc.create(validParams({ respondent: '' }))).toThrow(
        'respondent is required',
      );
    });

    it('should throw if claimant and respondent are the same', () => {
      expect(() =>
        svc.create(validParams({ claimant: '0xSame', respondent: '0xSame' })),
      ).toThrow('claimant and respondent must be different');
    });

    it('should throw if reason is empty', () => {
      expect(() => svc.create(validParams({ reason: '' }))).toThrow(
        'reason is required',
      );
    });

    it('should throw if deadline is in the past', () => {
      expect(() =>
        svc.create(validParams({ deadline: pastDate() })),
      ).toThrow('deadline must be in the future');
    });

    it('should throw if deadline is not a valid date', () => {
      expect(() =>
        svc.create(validParams({ deadline: 'not-a-date' })),
      ).toThrow('deadline must be a valid ISO-8601 date');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Read
  // ══════════════════════════════════════════════════════════════════════

  describe('getById() / list()', () => {
    it('should retrieve a dispute by id', () => {
      const created = svc.create(validParams());
      const found = svc.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it('should return undefined for unknown id', () => {
      expect(svc.getById('nope')).toBeUndefined();
    });

    it('should return a defensive copy from getById', () => {
      const created = svc.create(validParams());
      const copy = svc.getById(created.id)!;
      copy.reason = 'hacked';
      expect(svc.getById(created.id)!.reason).toBe('Fraudulent attestation');
    });

    it('should list all disputes', () => {
      svc.create(validParams());
      svc.create(validParams({ claimant: '0xA', respondent: '0xB', reason: '2' }));
      expect(svc.list()).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Status transitions
  // ══════════════════════════════════════════════════════════════════════

  describe('transitionStatus()', () => {
    it('OPEN → EVIDENCE is valid', () => {
      const d = svc.create(validParams());
      const updated = svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      expect(updated.status).toBe(DisputeStatus.EVIDENCE);
    });

    it('OPEN → EXPIRED is valid', () => {
      const d = svc.create(validParams());
      const updated = svc.transitionStatus(d.id, DisputeStatus.EXPIRED);
      expect(updated.status).toBe(DisputeStatus.EXPIRED);
    });

    it('OPEN → ESCALATED is valid', () => {
      const d = svc.create(validParams());
      const updated = svc.transitionStatus(d.id, DisputeStatus.ESCALATED);
      expect(updated.status).toBe(DisputeStatus.ESCALATED);
    });

    it('EVIDENCE → VOTING is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      const updated = svc.transitionStatus(d.id, DisputeStatus.VOTING);
      expect(updated.status).toBe(DisputeStatus.VOTING);
    });

    it('EVIDENCE → EXPIRED is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      const updated = svc.transitionStatus(d.id, DisputeStatus.EXPIRED);
      expect(updated.status).toBe(DisputeStatus.EXPIRED);
    });

    it('VOTING → RESOLVED is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      const updated = svc.transitionStatus(d.id, DisputeStatus.RESOLVED);
      expect(updated.status).toBe(DisputeStatus.RESOLVED);
    });

    it('VOTING → ESCALATED is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      const updated = svc.transitionStatus(d.id, DisputeStatus.ESCALATED);
      expect(updated.status).toBe(DisputeStatus.ESCALATED);
    });

    it('ESCALATED → VOTING is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.ESCALATED);
      const updated = svc.transitionStatus(d.id, DisputeStatus.VOTING);
      expect(updated.status).toBe(DisputeStatus.VOTING);
    });

    it('ESCALATED → RESOLVED is valid', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.ESCALATED);
      const updated = svc.transitionStatus(d.id, DisputeStatus.RESOLVED);
      expect(updated.status).toBe(DisputeStatus.RESOLVED);
    });

    // ── Invalid transitions ─────────────────────────────────────────────

    it('should throw on OPEN → VOTING (invalid)', () => {
      const d = svc.create(validParams());
      expect(() =>
        svc.transitionStatus(d.id, DisputeStatus.VOTING),
      ).toThrow('Invalid transition');
    });

    it('should throw on OPEN → RESOLVED (invalid)', () => {
      const d = svc.create(validParams());
      expect(() =>
        svc.transitionStatus(d.id, DisputeStatus.RESOLVED),
      ).toThrow('Invalid transition');
    });

    it('should throw on RESOLVED → anything (terminal)', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      svc.transitionStatus(d.id, DisputeStatus.RESOLVED);
      expect(() =>
        svc.transitionStatus(d.id, DisputeStatus.OPEN),
      ).toThrow('Invalid transition');
    });

    it('should throw on EXPIRED → anything (terminal)', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EXPIRED);
      expect(() =>
        svc.transitionStatus(d.id, DisputeStatus.OPEN),
      ).toThrow('Invalid transition');
    });

    it('should throw for unknown dispute id', () => {
      expect(() =>
        svc.transitionStatus('unknown', DisputeStatus.EVIDENCE),
      ).toThrow('Dispute not found');
    });

    it('should update updatedAt on transition', () => {
      const d = svc.create(validParams());
      const updated = svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      expect(updated.updatedAt).toBeTruthy();
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(d.createdAt).getTime(),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Resolve
  // ══════════════════════════════════════════════════════════════════════

  describe('resolve()', () => {
    it('should resolve a VOTING dispute with CLAIMANT_WINS', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);

      const resolved = svc.resolve(d.id, DisputeOutcome.CLAIMANT_WINS);
      expect(resolved.status).toBe(DisputeStatus.RESOLVED);
      expect(resolved.outcome).toBe(DisputeOutcome.CLAIMANT_WINS);
    });

    it('should resolve with RESPONDENT_WINS', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);

      const resolved = svc.resolve(d.id, DisputeOutcome.RESPONDENT_WINS);
      expect(resolved.outcome).toBe(DisputeOutcome.RESPONDENT_WINS);
    });

    it('should resolve with SETTLED', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);

      const resolved = svc.resolve(d.id, DisputeOutcome.SETTLED);
      expect(resolved.outcome).toBe(DisputeOutcome.SETTLED);
    });

    it('should resolve with DISMISSED', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);

      const resolved = svc.resolve(d.id, DisputeOutcome.DISMISSED);
      expect(resolved.outcome).toBe(DisputeOutcome.DISMISSED);
    });

    it('should throw when resolving a non-VOTING dispute', () => {
      const d = svc.create(validParams());
      expect(() => svc.resolve(d.id, DisputeOutcome.SETTLED)).toThrow(
        'Cannot resolve dispute in OPEN status',
      );
    });

    it('should throw for unknown dispute id', () => {
      expect(() =>
        svc.resolve('no-such-id', DisputeOutcome.SETTLED),
      ).toThrow('Dispute not found');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Evidence
  // ══════════════════════════════════════════════════════════════════════

  describe('addEvidence()', () => {
    it('should add evidence in OPEN status', () => {
      const d = svc.create(validParams());
      const updated = svc.addEvidence(d.id, [
        { label: 'proof', uri: 'ipfs://QmAbc' },
      ]);
      expect(updated.evidenceRefs).toHaveLength(1);
    });

    it('should add evidence in EVIDENCE status', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      const updated = svc.addEvidence(d.id, [
        { label: 'proof', uri: 'ipfs://QmAbc' },
      ]);
      expect(updated.evidenceRefs).toHaveLength(1);
    });

    it('should accumulate multiple evidence submissions', () => {
      const d = svc.create(validParams());
      svc.addEvidence(d.id, [{ label: 'a', uri: 'u1' }]);
      const updated = svc.addEvidence(d.id, [
        { label: 'b', uri: 'u2' },
        { label: 'c', uri: 'u3' },
      ]);
      expect(updated.evidenceRefs).toHaveLength(3);
    });

    it('should reject evidence in VOTING status', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      expect(() =>
        svc.addEvidence(d.id, [{ label: 'x', uri: 'y' }]),
      ).toThrow('Cannot add evidence in VOTING status');
    });

    it('should reject evidence in RESOLVED status', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      svc.resolve(d.id, DisputeOutcome.SETTLED);
      expect(() =>
        svc.addEvidence(d.id, [{ label: 'x', uri: 'y' }]),
      ).toThrow('Cannot add evidence in RESOLVED status');
    });

    it('should throw for unknown dispute id', () => {
      expect(() =>
        svc.addEvidence('nope', [{ label: 'x', uri: 'y' }]),
      ).toThrow('Dispute not found');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Deadline
  // ══════════════════════════════════════════════════════════════════════

  describe('isExpired()', () => {
    it('should return false for a dispute with a future deadline', () => {
      const d = svc.create(validParams({ deadline: futureDate(30) }));
      expect(svc.isExpired(d.id)).toBe(false);
    });

    it('should throw for unknown dispute id', () => {
      expect(() => svc.isExpired('nope')).toThrow('Dispute not found');
    });
  });

  describe('expireOverdue()', () => {
    it('should expire OPEN disputes past their deadline', () => {
      // We create a dispute then mutate its deadline directly via internals
      const d = svc.create(validParams());
      // Access internal map to set a past deadline for testing
      const internal = (svc as unknown as { disputes: Map<string, { deadline: string; status: DisputeStatus }> }).disputes.get(d.id)!;
      internal.deadline = pastDate();

      const expired = svc.expireOverdue();
      expect(expired).toContain(d.id);
      expect(svc.getById(d.id)!.status).toBe(DisputeStatus.EXPIRED);
    });

    it('should expire EVIDENCE disputes past their deadline', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      const internal = (svc as unknown as { disputes: Map<string, { deadline: string }> }).disputes.get(d.id)!;
      internal.deadline = pastDate();

      const expired = svc.expireOverdue();
      expect(expired).toContain(d.id);
    });

    it('should NOT expire VOTING disputes', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);
      const internal = (svc as unknown as { disputes: Map<string, { deadline: string }> }).disputes.get(d.id)!;
      internal.deadline = pastDate();

      const expired = svc.expireOverdue();
      expect(expired).not.toContain(d.id);
    });

    it('should return empty array when nothing is overdue', () => {
      svc.create(validParams({ deadline: futureDate(30) }));
      expect(svc.expireOverdue()).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════

  describe('size / clear()', () => {
    it('should report correct size', () => {
      expect(svc.size).toBe(0);
      svc.create(validParams());
      expect(svc.size).toBe(1);
    });

    it('should clear all disputes', () => {
      svc.create(validParams());
      svc.clear();
      expect(svc.size).toBe(0);
      expect(svc.list()).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Full lifecycle integration
  // ══════════════════════════════════════════════════════════════════════

  describe('full lifecycle', () => {
    it('OPEN → EVIDENCE → VOTING → RESOLVED (CLAIMANT_WINS)', () => {
      const d = svc.create(validParams({
        evidenceRefs: [{ label: 'initial', uri: 'ipfs://Qm0' }],
      }));

      expect(d.status).toBe(DisputeStatus.OPEN);

      // Add more evidence
      svc.addEvidence(d.id, [{ label: 'tx', uri: '0xabc' }]);

      // Transition through lifecycle
      svc.transitionStatus(d.id, DisputeStatus.EVIDENCE);
      svc.addEvidence(d.id, [{ label: 'response', uri: 'ipfs://QmResp' }]);
      svc.transitionStatus(d.id, DisputeStatus.VOTING);

      const resolved = svc.resolve(d.id, DisputeOutcome.CLAIMANT_WINS);
      expect(resolved.status).toBe(DisputeStatus.RESOLVED);
      expect(resolved.outcome).toBe(DisputeOutcome.CLAIMANT_WINS);
      expect(resolved.evidenceRefs).toHaveLength(3);
    });

    it('OPEN → ESCALATED → RESOLVED (SETTLED)', () => {
      const d = svc.create(validParams());
      svc.transitionStatus(d.id, DisputeStatus.ESCALATED);
      const resolved = svc.resolve(d.id, DisputeOutcome.SETTLED);
      expect(resolved.status).toBe(DisputeStatus.RESOLVED);
      expect(resolved.outcome).toBe(DisputeOutcome.SETTLED);
    });
  });
});
