/**
 * @file Unit tests for ArbitrationLogService.
 *
 * Test scenarios:
 * ─ Append: valid entry, missing fields, invalid event type, immutability
 * ─ Read: findById, getTimeline
 * ─ Query: by disputeId, identity, eventTypes, time range, pagination
 * ─ Sequence numbering: per-dispute monotonic counters
 * ─ Helpers: size, clear
 * ─ Integration: full lifecycle audit trail
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ArbitrationLogService } from './arbitrationLogService.js';
import { ArbitrationEventType } from '../../types/governance.js';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ArbitrationLogService', () => {
  let svc: ArbitrationLogService;

  beforeEach(() => {
    svc = new ArbitrationLogService();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Append
  // ══════════════════════════════════════════════════════════════════════

  describe('append()', () => {
    it('should create an immutable log entry', () => {
      const entry = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: { claimant: '0xA', respondent: '0xB', reason: 'test' },
        actor: '0xA',
      });

      expect(entry.id).toBeTruthy();
      expect(entry.disputeId).toBe('d-1');
      expect(entry.eventType).toBe(ArbitrationEventType.DISPUTE_OPENED);
      expect(entry.actor).toBe('0xA');
      expect(entry.sequenceNumber).toBe(1);
      expect(entry.timestamp).toBeTruthy();
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('should prevent mutation of stored entry', () => {
      const entry = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });

      expect(() => {
        (entry as Record<string, unknown>).actor = 'hacked';
      }).toThrow();
    });

    it('should assign sequential sequence numbers per dispute', () => {
      const e1 = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      const e2 = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.EVIDENCE_SUBMITTED,
        payload: {},
        actor: '0xB',
      });
      const e3 = svc.append({
        disputeId: 'd-2',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xC',
      });

      expect(e1.sequenceNumber).toBe(1);
      expect(e2.sequenceNumber).toBe(2);
      expect(e3.sequenceNumber).toBe(1); // different dispute, restarts
    });

    // ── Validation ──────────────────────────────────────────────────────

    it('should throw if disputeId is empty', () => {
      expect(() =>
        svc.append({
          disputeId: '',
          eventType: ArbitrationEventType.DISPUTE_OPENED,
          payload: {},
          actor: '0xA',
        }),
      ).toThrow('disputeId is required');
    });

    it('should throw if actor is empty', () => {
      expect(() =>
        svc.append({
          disputeId: 'd-1',
          eventType: ArbitrationEventType.DISPUTE_OPENED,
          payload: {},
          actor: '',
        }),
      ).toThrow('actor is required');
    });

    it('should throw for invalid event type', () => {
      expect(() =>
        svc.append({
          disputeId: 'd-1',
          eventType: 'INVALID' as ArbitrationEventType,
          payload: {},
          actor: '0xA',
        }),
      ).toThrow('Invalid event type');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Read
  // ══════════════════════════════════════════════════════════════════════

  describe('findById()', () => {
    it('should find an entry by its id', () => {
      const entry = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });

      const found = svc.findById(entry.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(entry.id);
    });

    it('should return undefined for unknown id', () => {
      expect(svc.findById('nope')).toBeUndefined();
    });
  });

  describe('getTimeline()', () => {
    it('should return entries sorted by sequence number', () => {
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.EVIDENCE_SUBMITTED,
        payload: {},
        actor: '0xB',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: {},
        actor: '0xC',
      });
      svc.append({
        disputeId: 'd-2',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xD',
      });

      const timeline = svc.getTimeline('d-1');
      expect(timeline).toHaveLength(3);
      expect(timeline[0].sequenceNumber).toBe(1);
      expect(timeline[1].sequenceNumber).toBe(2);
      expect(timeline[2].sequenceNumber).toBe(3);
    });

    it('should return empty array for unknown dispute', () => {
      expect(svc.getTimeline('nope')).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Query
  // ══════════════════════════════════════════════════════════════════════

  describe('query()', () => {
    beforeEach(() => {
      // Seed: 5 entries across 2 disputes, various actors and types
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: 'alice',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.EVIDENCE_SUBMITTED,
        payload: {},
        actor: 'bob',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: {},
        actor: 'charlie',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_RESOLVED,
        payload: {},
        actor: 'alice',
      });
      svc.append({
        disputeId: 'd-2',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: 'alice',
      });
    });

    it('should return all entries with no filter', () => {
      expect(svc.query()).toHaveLength(5);
    });

    it('should filter by disputeId', () => {
      const results = svc.query({ disputeId: 'd-1' });
      expect(results).toHaveLength(4);
    });

    it('should filter by identity (actor)', () => {
      const results = svc.query({ identity: 'alice' });
      expect(results).toHaveLength(3);
    });

    it('should filter by single eventType', () => {
      const results = svc.query({
        eventTypes: [ArbitrationEventType.VOTE_CAST],
      });
      expect(results).toHaveLength(1);
    });

    it('should filter by multiple eventTypes', () => {
      const results = svc.query({
        eventTypes: [
          ArbitrationEventType.DISPUTE_OPENED,
          ArbitrationEventType.DISPUTE_RESOLVED,
        ],
      });
      expect(results).toHaveLength(3);
    });

    it('should filter by time range (from)', () => {
      // All entries have timestamps very close to "now", so using a past date returns all
      const results = svc.query({ from: '2020-01-01T00:00:00.000Z' });
      expect(results).toHaveLength(5);
    });

    it('should filter by time range (to) that excludes future', () => {
      const results = svc.query({ to: '2020-01-01T00:00:00.000Z' });
      expect(results).toHaveLength(0);
    });

    it('should combine filters (disputeId + identity)', () => {
      const results = svc.query({ disputeId: 'd-1', identity: 'alice' });
      expect(results).toHaveLength(2);
    });

    it('should respect limit', () => {
      const results = svc.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('should respect offset', () => {
      const results = svc.query({ offset: 3 });
      expect(results).toHaveLength(2);
    });

    it('should respect limit + offset', () => {
      const results = svc.query({ limit: 2, offset: 1 });
      expect(results).toHaveLength(2);
    });

    it('should return entries sorted by timestamp', () => {
      const results = svc.query();
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp >= results[i - 1].timestamp).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════

  describe('size / clear()', () => {
    it('should report correct size', () => {
      expect(svc.size).toBe(0);
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      expect(svc.size).toBe(1);
    });

    it('should clear entries and reset sequence counters', () => {
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: {},
        actor: '0xB',
      });
      svc.clear();
      expect(svc.size).toBe(0);

      // Sequence should restart
      const entry = svc.append({
        disputeId: 'd-1',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      expect(entry.sequenceNumber).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Integration: full lifecycle audit trail
  // ══════════════════════════════════════════════════════════════════════

  describe('full lifecycle audit trail', () => {
    it('should record all events in correct order', () => {
      const disputeId = 'd-lifecycle';

      svc.append({
        disputeId,
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: { claimant: '0xA', respondent: '0xB', reason: 'fraud' },
        actor: '0xA',
      });

      svc.append({
        disputeId,
        eventType: ArbitrationEventType.EVIDENCE_SUBMITTED,
        payload: { submittedBy: '0xB', evidenceRefs: [{ label: 'doc', uri: 'ipfs://Qm1' }] },
        actor: '0xB',
      });

      svc.append({
        disputeId,
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: { voter: '0xArb1', direction: 'FOR_CLAIMANT' },
        actor: '0xArb1',
      });

      svc.append({
        disputeId,
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: { voter: '0xArb2', direction: 'FOR_RESPONDENT' },
        actor: '0xArb2',
      });

      svc.append({
        disputeId,
        eventType: ArbitrationEventType.DISPUTE_RESOLVED,
        payload: { outcome: 'CLAIMANT_WINS', summary: 'Majority rules' },
        actor: '0xPanel',
      });

      const timeline = svc.getTimeline(disputeId);
      expect(timeline).toHaveLength(5);
      expect(timeline[0].eventType).toBe(ArbitrationEventType.DISPUTE_OPENED);
      expect(timeline[1].eventType).toBe(ArbitrationEventType.EVIDENCE_SUBMITTED);
      expect(timeline[2].eventType).toBe(ArbitrationEventType.VOTE_CAST);
      expect(timeline[3].eventType).toBe(ArbitrationEventType.VOTE_CAST);
      expect(timeline[4].eventType).toBe(ArbitrationEventType.DISPUTE_RESOLVED);

      // Verify sequence numbers
      timeline.forEach((e, i) => {
        expect(e.sequenceNumber).toBe(i + 1);
      });

      // Every entry is frozen
      timeline.forEach((e) => {
        expect(Object.isFrozen(e)).toBe(true);
      });
    });

    it('should keep separate timelines for different disputes', () => {
      svc.append({
        disputeId: 'd-A',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xA',
      });
      svc.append({
        disputeId: 'd-B',
        eventType: ArbitrationEventType.DISPUTE_OPENED,
        payload: {},
        actor: '0xB',
      });
      svc.append({
        disputeId: 'd-A',
        eventType: ArbitrationEventType.VOTE_CAST,
        payload: {},
        actor: '0xC',
      });

      expect(svc.getTimeline('d-A')).toHaveLength(2);
      expect(svc.getTimeline('d-B')).toHaveLength(1);
      expect(svc.size).toBe(3);
    });
  });
});
