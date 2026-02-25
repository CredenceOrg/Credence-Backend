/**
 * @file Unit tests for MultiSigService.
 *
 * Test scenarios:
 * ─ Creation: valid params, validation failures (missing fields, bad threshold, duplicate signers, past deadline)
 * ─ Read: getById, list
 * ─ Signing: valid sign, duplicate sign, unauthorized signer, expired proposal, non-pending
 * ─ Auto-approval: threshold met triggers PENDING → APPROVED
 * ─ Rejection: reject pending, reject non-pending
 * ─ Execution: execute approved, execute non-approved
 * ─ Expiration: expireOverdue
 * ─ State transitions: PENDING→APPROVED→EXECUTED, PENDING→REJECTED, PENDING→EXPIRED
 * ─ Helpers: size, clear
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { MultiSigService } from './multiSigService.js';
import { MultiSigStatus } from '../../types/governance.js';
import type { CreateMultiSigParams } from '../../types/governance.js';

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

function validParams(overrides: Partial<CreateMultiSigParams> = {}): CreateMultiSigParams {
  return {
    title: 'Protocol Upgrade v2',
    description: 'Upgrade the attestation module',
    proposer: '0xProposer',
    signers: ['0xSigner1', '0xSigner2', '0xSigner3'],
    threshold: 2,
    deadline: futureDate(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MultiSigService', () => {
  let svc: MultiSigService;

  beforeEach(() => {
    svc = new MultiSigService();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Creation
  // ══════════════════════════════════════════════════════════════════════

  describe('create()', () => {
    it('should create a proposal with valid params', () => {
      const p = svc.create(validParams());
      expect(p.id).toBeTruthy();
      expect(p.title).toBe('Protocol Upgrade v2');
      expect(p.description).toBe('Upgrade the attestation module');
      expect(p.proposer).toBe('0xProposer');
      expect(p.status).toBe(MultiSigStatus.PENDING);
      expect(p.signers).toEqual(['0xSigner1', '0xSigner2', '0xSigner3']);
      expect(p.signatures).toEqual([]);
      expect(p.threshold).toBe(2);
      expect(p.createdAt).toBeTruthy();
      expect(p.updatedAt).toBeTruthy();
      expect(p.deadline).toBeTruthy();
    });

    it('should apply default deadline when omitted', () => {
      const p = svc.create(validParams({ deadline: undefined }));
      const dl = new Date(p.deadline);
      const diffDays = (dl.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThanOrEqual(7.01);
    });

    // ── Validation failures ─────────────────────────────────────────────

    it('should throw if title is empty', () => {
      expect(() => svc.create(validParams({ title: '' }))).toThrow(
        'title is required',
      );
    });

    it('should throw if description is empty', () => {
      expect(() => svc.create(validParams({ description: '' }))).toThrow(
        'description is required',
      );
    });

    it('should throw if proposer is empty', () => {
      expect(() => svc.create(validParams({ proposer: '' }))).toThrow(
        'proposer is required',
      );
    });

    it('should throw if signers is empty', () => {
      expect(() => svc.create(validParams({ signers: [] }))).toThrow(
        'at least one signer',
      );
    });

    it('should throw if signers has duplicates', () => {
      expect(() =>
        svc.create(validParams({ signers: ['0xA', '0xA', '0xB'] })),
      ).toThrow('signers must be unique');
    });

    it('should throw if threshold is 0', () => {
      expect(() => svc.create(validParams({ threshold: 0 }))).toThrow(
        'threshold must be a positive integer',
      );
    });

    it('should throw if threshold is negative', () => {
      expect(() => svc.create(validParams({ threshold: -1 }))).toThrow(
        'threshold must be a positive integer',
      );
    });

    it('should throw if threshold is not an integer', () => {
      expect(() => svc.create(validParams({ threshold: 1.5 }))).toThrow(
        'threshold must be a positive integer',
      );
    });

    it('should throw if threshold exceeds signers count', () => {
      expect(() =>
        svc.create(validParams({ threshold: 10 })),
      ).toThrow('threshold cannot exceed');
    });

    it('should throw if deadline is in the past', () => {
      expect(() =>
        svc.create(validParams({ deadline: pastDate() })),
      ).toThrow('deadline must be in the future');
    });

    it('should throw if deadline is invalid', () => {
      expect(() =>
        svc.create(validParams({ deadline: 'bad-date' })),
      ).toThrow('deadline must be a valid ISO-8601 date');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Read
  // ══════════════════════════════════════════════════════════════════════

  describe('getById() / list()', () => {
    it('should retrieve a proposal by id', () => {
      const p = svc.create(validParams());
      const found = svc.getById(p.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(p.id);
    });

    it('should return undefined for unknown id', () => {
      expect(svc.getById('nope')).toBeUndefined();
    });

    it('should return a defensive copy from getById', () => {
      const p = svc.create(validParams());
      const copy = svc.getById(p.id)!;
      copy.title = 'hacked';
      expect(svc.getById(p.id)!.title).toBe('Protocol Upgrade v2');
    });

    it('should list all proposals', () => {
      svc.create(validParams());
      svc.create(validParams({ title: 'Another' }));
      expect(svc.list()).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Signing
  // ══════════════════════════════════════════════════════════════════════

  describe('sign()', () => {
    it('should add a signature from an authorized signer', () => {
      const p = svc.create(validParams());
      const updated = svc.sign(p.id, '0xSigner1');
      expect(updated.signatures).toContain('0xSigner1');
      expect(updated.status).toBe(MultiSigStatus.PENDING); // threshold not yet met
    });

    it('should throw for unauthorized signer', () => {
      const p = svc.create(validParams());
      expect(() => svc.sign(p.id, '0xRandom')).toThrow(
        'not an authorized signer',
      );
    });

    it('should throw for duplicate signature', () => {
      const p = svc.create(validParams());
      svc.sign(p.id, '0xSigner1');
      expect(() => svc.sign(p.id, '0xSigner1')).toThrow(
        'already signed',
      );
    });

    it('should throw for unknown proposal', () => {
      expect(() => svc.sign('nope', '0xSigner1')).toThrow(
        'Proposal not found',
      );
    });

    it('should throw when signing a non-PENDING proposal', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      svc.sign(p.id, '0xSigner1'); // auto-approves
      expect(() => svc.sign(p.id, '0xSigner2')).toThrow(
        'Cannot sign proposal in APPROVED status',
      );
    });

    it('should throw and mark as EXPIRED when deadline has passed', () => {
      const p = svc.create(validParams());
      // Mutate deadline to the past for testing
      const internal = (svc as unknown as { proposals: Map<string, { deadline: string }> }).proposals.get(p.id)!;
      internal.deadline = pastDate();

      expect(() => svc.sign(p.id, '0xSigner1')).toThrow('expired');
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.EXPIRED);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Auto-approval (threshold met)
  // ══════════════════════════════════════════════════════════════════════

  describe('auto-approval on threshold', () => {
    it('should auto-approve when threshold is reached (threshold = 1)', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      const updated = svc.sign(p.id, '0xSigner1');
      expect(updated.status).toBe(MultiSigStatus.APPROVED);
    });

    it('should auto-approve when threshold is reached (threshold = 2)', () => {
      const p = svc.create(validParams({ threshold: 2 }));
      svc.sign(p.id, '0xSigner1');
      const updated = svc.sign(p.id, '0xSigner2');
      expect(updated.status).toBe(MultiSigStatus.APPROVED);
      expect(updated.signatures).toEqual(['0xSigner1', '0xSigner2']);
    });

    it('should auto-approve when threshold equals number of signers', () => {
      const p = svc.create(validParams({ threshold: 3 }));
      svc.sign(p.id, '0xSigner1');
      svc.sign(p.id, '0xSigner2');
      const updated = svc.sign(p.id, '0xSigner3');
      expect(updated.status).toBe(MultiSigStatus.APPROVED);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Rejection
  // ══════════════════════════════════════════════════════════════════════

  describe('reject()', () => {
    it('should reject a PENDING proposal', () => {
      const p = svc.create(validParams());
      const rejected = svc.reject(p.id);
      expect(rejected.status).toBe(MultiSigStatus.REJECTED);
    });

    it('should throw for unknown proposal', () => {
      expect(() => svc.reject('nope')).toThrow('Proposal not found');
    });

    it('should throw for non-PENDING proposal (APPROVED)', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      svc.sign(p.id, '0xSigner1');
      expect(() => svc.reject(p.id)).toThrow(
        'Cannot reject proposal in APPROVED status',
      );
    });

    it('should throw for non-PENDING proposal (REJECTED)', () => {
      const p = svc.create(validParams());
      svc.reject(p.id);
      expect(() => svc.reject(p.id)).toThrow(
        'Cannot reject proposal in REJECTED status',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Execution
  // ══════════════════════════════════════════════════════════════════════

  describe('execute()', () => {
    it('should execute an APPROVED proposal', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      svc.sign(p.id, '0xSigner1');
      const executed = svc.execute(p.id);
      expect(executed.status).toBe(MultiSigStatus.EXECUTED);
    });

    it('should throw for unknown proposal', () => {
      expect(() => svc.execute('nope')).toThrow('Proposal not found');
    });

    it('should throw for PENDING proposal', () => {
      const p = svc.create(validParams());
      expect(() => svc.execute(p.id)).toThrow(
        'Cannot execute proposal in PENDING status',
      );
    });

    it('should throw for REJECTED proposal', () => {
      const p = svc.create(validParams());
      svc.reject(p.id);
      expect(() => svc.execute(p.id)).toThrow(
        'Cannot execute proposal in REJECTED status',
      );
    });

    it('should throw for already EXECUTED proposal', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      svc.sign(p.id, '0xSigner1');
      svc.execute(p.id);
      expect(() => svc.execute(p.id)).toThrow(
        'Cannot execute proposal in EXECUTED status',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Expiration
  // ══════════════════════════════════════════════════════════════════════

  describe('expireOverdue()', () => {
    it('should expire PENDING proposals past their deadline', () => {
      const p = svc.create(validParams());
      const internal = (svc as unknown as { proposals: Map<string, { deadline: string }> }).proposals.get(p.id)!;
      internal.deadline = pastDate();

      const expired = svc.expireOverdue();
      expect(expired).toContain(p.id);
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.EXPIRED);
    });

    it('should NOT expire APPROVED proposals', () => {
      const p = svc.create(validParams({ threshold: 1 }));
      svc.sign(p.id, '0xSigner1');
      const internal = (svc as unknown as { proposals: Map<string, { deadline: string }> }).proposals.get(p.id)!;
      internal.deadline = pastDate();

      const expired = svc.expireOverdue();
      expect(expired).not.toContain(p.id);
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

    it('should clear all proposals', () => {
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
    it('PENDING → APPROVED → EXECUTED', () => {
      const p = svc.create(
        validParams({ threshold: 2 }),
      );
      expect(p.status).toBe(MultiSigStatus.PENDING);

      svc.sign(p.id, '0xSigner1');
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.PENDING);

      svc.sign(p.id, '0xSigner2');
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.APPROVED);

      const executed = svc.execute(p.id);
      expect(executed.status).toBe(MultiSigStatus.EXECUTED);
    });

    it('PENDING → REJECTED (no further transitions)', () => {
      const p = svc.create(validParams());
      svc.reject(p.id);
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.REJECTED);

      // Cannot sign or execute
      expect(() => svc.sign(p.id, '0xSigner1')).toThrow();
      expect(() => svc.execute(p.id)).toThrow();
    });

    it('PENDING → EXPIRED (via expireOverdue)', () => {
      const p = svc.create(validParams());
      const internal = (svc as unknown as { proposals: Map<string, { deadline: string }> }).proposals.get(p.id)!;
      internal.deadline = pastDate();

      svc.expireOverdue();
      expect(svc.getById(p.id)!.status).toBe(MultiSigStatus.EXPIRED);
    });
  });
});
