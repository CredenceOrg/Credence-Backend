/**
 * @file Tests for ArbitrationLogRepository.
 *
 * Covers:
 * - append & immutability guarantees
 * - duplicate-id rejection
 * - findById
 * - findByDisputeId with ordering
 * - query filtering (disputeId, identity, eventTypes, time range)
 * - pagination (limit / offset)
 * - sequenceNumber generation
 * - size & all()
 * - clear()
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ArbitrationLogRepository } from '../../src/repositories/arbitrationLogRepository.js';
import type { ArbitrationLogEntry } from '../../src/types/governance.js';
import { ArbitrationEventType } from '../../src/types/governance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<ArbitrationLogEntry> = {},
): ArbitrationLogEntry {
  return {
    id: overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`,
    disputeId: overrides.disputeId ?? 'dispute-1',
    eventType: overrides.eventType ?? ArbitrationEventType.DISPUTE_OPENED,
    payload: overrides.payload ?? ({
      claimant: '0xAAA',
      respondent: '0xBBB',
      reason: 'test',
    } as ArbitrationLogEntry['payload']),
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    actor: overrides.actor ?? '0xAAA',
    sequenceNumber: overrides.sequenceNumber ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArbitrationLogRepository', () => {
  let repo: ArbitrationLogRepository;

  beforeEach(() => {
    repo = new ArbitrationLogRepository();
  });

  // -- append & immutability -----------------------------------------------

  describe('append()', () => {
    it('should store an entry and return a frozen copy', () => {
      const entry = makeEntry({ id: 'e1' });
      const stored = repo.append(entry);

      expect(stored).toEqual(entry);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    it('should throw when id is empty', () => {
      const entry = makeEntry({ id: '' });
      expect(() => repo.append(entry)).toThrow('non-empty id');
    });

    it('should throw on duplicate id', () => {
      repo.append(makeEntry({ id: 'dup' }));
      expect(() => repo.append(makeEntry({ id: 'dup' }))).toThrow(
        'Duplicate',
      );
    });

    it('should not allow mutation of stored entry', () => {
      const stored = repo.append(makeEntry({ id: 'frozen' }));
      expect(() => {
        (stored as Record<string, unknown>).actor = 'hacked';
      }).toThrow();
    });
  });

  // -- findById ------------------------------------------------------------

  describe('findById()', () => {
    it('should return the entry with the given id', () => {
      repo.append(makeEntry({ id: 'find-me' }));
      const found = repo.findById('find-me');
      expect(found).toBeDefined();
      expect(found!.id).toBe('find-me');
    });

    it('should return undefined for unknown id', () => {
      expect(repo.findById('nope')).toBeUndefined();
    });
  });

  // -- findByDisputeId -----------------------------------------------------

  describe('findByDisputeId()', () => {
    it('should return entries matching disputeId in sequence order', () => {
      repo.append(makeEntry({ id: 'a', disputeId: 'd1', sequenceNumber: 2 }));
      repo.append(makeEntry({ id: 'b', disputeId: 'd1', sequenceNumber: 1 }));
      repo.append(makeEntry({ id: 'c', disputeId: 'd2', sequenceNumber: 1 }));

      const results = repo.findByDisputeId('d1');
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('b'); // seq 1 first
      expect(results[1].id).toBe('a'); // seq 2 second
    });

    it('should return empty array for unknown disputeId', () => {
      expect(repo.findByDisputeId('nope')).toEqual([]);
    });
  });

  // -- query ---------------------------------------------------------------

  describe('query()', () => {
    beforeEach(() => {
      // Seed 5 entries across 2 disputes
      repo.append(
        makeEntry({
          id: 'q1',
          disputeId: 'd1',
          actor: 'alice',
          eventType: ArbitrationEventType.DISPUTE_OPENED,
          timestamp: '2026-01-01T00:00:00.000Z',
          sequenceNumber: 1,
        }),
      );
      repo.append(
        makeEntry({
          id: 'q2',
          disputeId: 'd1',
          actor: 'bob',
          eventType: ArbitrationEventType.VOTE_CAST,
          timestamp: '2026-01-02T00:00:00.000Z',
          sequenceNumber: 2,
        }),
      );
      repo.append(
        makeEntry({
          id: 'q3',
          disputeId: 'd1',
          actor: 'charlie',
          eventType: ArbitrationEventType.VOTE_CAST,
          timestamp: '2026-01-03T00:00:00.000Z',
          sequenceNumber: 3,
        }),
      );
      repo.append(
        makeEntry({
          id: 'q4',
          disputeId: 'd1',
          actor: 'alice',
          eventType: ArbitrationEventType.DISPUTE_RESOLVED,
          timestamp: '2026-01-04T00:00:00.000Z',
          sequenceNumber: 4,
        }),
      );
      repo.append(
        makeEntry({
          id: 'q5',
          disputeId: 'd2',
          actor: 'alice',
          eventType: ArbitrationEventType.DISPUTE_OPENED,
          timestamp: '2026-01-05T00:00:00.000Z',
          sequenceNumber: 1,
        }),
      );
    });

    it('should return all entries when no filter is given', () => {
      const results = repo.query();
      expect(results).toHaveLength(5);
    });

    it('should filter by disputeId', () => {
      const results = repo.query({ disputeId: 'd1' });
      expect(results).toHaveLength(4);
      results.forEach((e) => expect(e.disputeId).toBe('d1'));
    });

    it('should filter by identity (actor)', () => {
      const results = repo.query({ identity: 'alice' });
      expect(results).toHaveLength(3);
      results.forEach((e) => expect(e.actor).toBe('alice'));
    });

    it('should filter by eventTypes', () => {
      const results = repo.query({
        eventTypes: [ArbitrationEventType.VOTE_CAST],
      });
      expect(results).toHaveLength(2);
    });

    it('should filter by multiple eventTypes', () => {
      const results = repo.query({
        eventTypes: [
          ArbitrationEventType.DISPUTE_OPENED,
          ArbitrationEventType.DISPUTE_RESOLVED,
        ],
      });
      expect(results).toHaveLength(3);
    });

    it('should filter by time range (from)', () => {
      const results = repo.query({ from: '2026-01-03T00:00:00.000Z' });
      expect(results).toHaveLength(3);
    });

    it('should filter by time range (to)', () => {
      const results = repo.query({ to: '2026-01-02T00:00:00.000Z' });
      expect(results).toHaveLength(2);
    });

    it('should filter by time range (from + to)', () => {
      const results = repo.query({
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-04T00:00:00.000Z',
      });
      expect(results).toHaveLength(3);
    });

    it('should combine filters', () => {
      const results = repo.query({
        disputeId: 'd1',
        identity: 'alice',
      });
      expect(results).toHaveLength(2);
    });

    it('should respect limit', () => {
      const results = repo.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('should respect offset', () => {
      const results = repo.query({ offset: 3 });
      expect(results).toHaveLength(2);
    });

    it('should respect limit + offset together', () => {
      const results = repo.query({ limit: 2, offset: 1 });
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('q2');
      expect(results[1].id).toBe('q3');
    });

    it('should return results sorted by timestamp ascending', () => {
      const results = repo.query();
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp >= results[i - 1].timestamp).toBe(true);
      }
    });
  });

  // -- sequenceNumber ------------------------------------------------------

  describe('nextSequenceNumber()', () => {
    it('should start at 1 and increment for the same dispute', () => {
      expect(repo.nextSequenceNumber('d1')).toBe(1);
      expect(repo.nextSequenceNumber('d1')).toBe(2);
      expect(repo.nextSequenceNumber('d1')).toBe(3);
    });

    it('should maintain independent counters per dispute', () => {
      expect(repo.nextSequenceNumber('d1')).toBe(1);
      expect(repo.nextSequenceNumber('d2')).toBe(1);
      expect(repo.nextSequenceNumber('d1')).toBe(2);
      expect(repo.nextSequenceNumber('d2')).toBe(2);
    });
  });

  // -- size, all, clear ----------------------------------------------------

  describe('size / all() / clear()', () => {
    it('should report correct size', () => {
      expect(repo.size).toBe(0);
      repo.append(makeEntry({ id: 's1' }));
      expect(repo.size).toBe(1);
    });

    it('all() should return a copy of entries', () => {
      repo.append(makeEntry({ id: 'a1' }));
      repo.append(makeEntry({ id: 'a2' }));
      const all = repo.all();
      expect(all).toHaveLength(2);
    });

    it('clear() should empty the repository', () => {
      repo.append(makeEntry({ id: 'c1' }));
      repo.clear();
      expect(repo.size).toBe(0);
      expect(repo.all()).toEqual([]);
    });

    it('clear() should reset sequence counters', () => {
      repo.nextSequenceNumber('d1');
      repo.nextSequenceNumber('d1');
      repo.clear();
      expect(repo.nextSequenceNumber('d1')).toBe(1);
    });
  });
});
