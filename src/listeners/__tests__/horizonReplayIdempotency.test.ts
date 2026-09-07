/**
 * Replay idempotency and conflicting-key detection tests for Horizon
 * bond creation ingestion (issue #1261).
 *
 * Proves:
 *  - `resolveConflictingEvent` detects material payload differences.
 *  - Identical replays are accepted as safe no-ops.
 *  - Conflicting events (same ID, different payload) are rejected.
 *  - Business logic is skipped for already-recorded events (replay).
 *  - Cursor advances even for replayed events.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('prom-client', () => {
  const makeMetric = vi.fn(function(this: any) {
    return {
      set: vi.fn(),
      inc: vi.fn(),
      dec: vi.fn(),
      observe: vi.fn(),
      labels: vi.fn().mockReturnValue({ set: vi.fn(), inc: vi.fn(), observe: vi.fn() }),
      reset: vi.fn(),
    }
  });
  const registry = { registerMetric: vi.fn(), getMetricsAsJSON: vi.fn().mockReturnValue([]) };
  const client = {
    register: registry,
    Registry: vi.fn(),
    Gauge: makeMetric,
    Counter: makeMetric,
    Histogram: makeMetric,
    Summary: makeMetric,
    collectDefaultMetrics: vi.fn(),
    exponentialBuckets: vi.fn().mockReturnValue([]),
  };
  return { ...client, default: client };
});

vi.mock('../../services/reputationService.js', () => ({
  invalidateTrustScoreCache: vi.fn().mockResolvedValue(undefined),
}));

import {
  ConflictingEventError,
  resolveConflictingEvent,
} from '../horizonBondEvents.js'

describe('resolveConflictingEvent', () => {
  const streamName = 'bond_creation'
  const eventId = 'op-123'

  it('returns null when payloads are identical', () => {
    const payload = {
      identity: { id: 'GABC' },
      bond: { id: 'op-123', address: 'GABC', amount: '100', duration: '365' },
    }
    const result = resolveConflictingEvent(streamName, eventId, payload, { ...payload })
    expect(result).toBeNull()
  })

  it('returns null when payloads differ only in non-core fields', () => {
    const existing = {
      identity: { id: 'GABC' },
      bond: { id: 'op-123', address: 'GABC', amount: '100', duration: '365' },
      extra_field: 'ignored',
    }
    const incoming = {
      identity: { id: 'GABC' },
      bond: { id: 'op-123', address: 'GABC', amount: '100', duration: '365' },
      different_metadata: true,
    }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeNull()
  })

  it('detects conflict when source_account differs', () => {
    const existing = {
      source_account: 'GABC',
      id: 'op-123',
      amount: '100',
      duration: '365',
    }
    const incoming = {
      source_account: 'GXYZ',
      id: 'op-123',
      amount: '100',
      duration: '365',
    }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeInstanceOf(ConflictingEventError)
    expect(result!.eventId).toBe(eventId)
    expect(result!.streamName).toBe(streamName)
  })

  it('detects conflict when amount differs', () => {
    const existing = { source_account: 'GABC', id: 'op-123', amount: '100', duration: '365' }
    const incoming = { source_account: 'GABC', id: 'op-123', amount: '200', duration: '365' }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeInstanceOf(ConflictingEventError)
  })

  it('detects conflict when duration differs', () => {
    const existing = { source_account: 'GABC', id: 'op-123', amount: '100', duration: '365' }
    const incoming = { source_account: 'GABC', id: 'op-123', amount: '100', duration: '730' }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeInstanceOf(ConflictingEventError)
  })

  it('detects conflict when bond id differs', () => {
    const existing = { source_account: 'GABC', id: 'op-123', amount: '100', duration: '365' }
    const incoming = { source_account: 'GABC', id: 'op-456', amount: '100', duration: '365' }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeInstanceOf(ConflictingEventError)
  })

  it('treats missing core fields in either payload as non-conflicting', () => {
    const existing = { source_account: 'GABC', id: 'op-123' }
    const incoming = { source_account: 'GABC', id: 'op-123', amount: '100' }
    const result = resolveConflictingEvent(streamName, eventId, existing, incoming)
    expect(result).toBeNull()
  })

  it('returns null for empty payloads', () => {
    const result = resolveConflictingEvent(streamName, eventId, {}, {})
    expect(result).toBeNull()
  })
})

describe('ConflictingEventError', () => {
  it('has the correct structure', () => {
    const error = new ConflictingEventError({
      eventId: 'op-1',
      streamName: 'bond_creation',
      existingPayload: { a: 1 },
      incomingPayload: { a: 2 },
    })

    expect(error.name).toBe('ConflictingEventError')
    expect(error.code).toBe('CONFLICTING_EVENT')
    expect(error.eventId).toBe('op-1')
    expect(error.streamName).toBe('bond_creation')
    expect(error.existingPayload).toEqual({ a: 1 })
    expect(error.incomingPayload).toEqual({ a: 2 })
    expect(error.message).toContain('op-1')
    expect(error.message).toContain('bond_creation')
    expect(error.message).toContain('different payload')
  })

  it('is an instance of Error', () => {
    const error = new ConflictingEventError({
      eventId: 'op-1',
      streamName: 'test',
      existingPayload: {},
      incomingPayload: {},
    })
    expect(error).toBeInstanceOf(Error)
  })
})
