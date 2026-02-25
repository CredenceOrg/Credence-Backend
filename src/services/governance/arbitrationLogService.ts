/**
 * @module services/governance/arbitrationLogService
 * @description Append-only, immutable audit trail for the dispute lifecycle.
 *
 * Every write creates a frozen {@link ArbitrationLogEntry}.  Once persisted
 * an entry can never be modified or deleted, ensuring a tamper-evident
 * governance record.
 */

import { randomUUID } from 'node:crypto';

import type {
  ArbitrationLogEntry,
  ArbitrationLogQuery,
} from '../../types/governance.js';
import { ArbitrationEventType } from '../../types/governance.js';

// ── Service ───────────────────────────────────────────────────────────────

/**
 * In-memory, append-only arbitration log service.
 *
 * @example
 * ```ts
 * const svc = new ArbitrationLogService();
 * svc.append({ disputeId: 'd-1', eventType: ArbitrationEventType.DISPUTE_OPENED, payload: {...}, actor: '0xA' });
 * const entries = svc.query({ disputeId: 'd-1' });
 * ```
 */
export class ArbitrationLogService {
  private readonly entries: ArbitrationLogEntry[] = [];
  private readonly seqCounters = new Map<string, number>();

  // ── Write ─────────────────────────────────────────────────────────────

  /**
   * Append an immutable log entry.
   *
   * @param params - Entry data (disputeId, eventType, payload, actor).
   * @returns The frozen entry as stored.
   * @throws {Error} If required fields are missing.
   */
  append(params: {
    disputeId: string;
    eventType: ArbitrationEventType;
    payload: Record<string, unknown>;
    actor: string;
  }): Readonly<ArbitrationLogEntry> {
    if (!params.disputeId?.trim()) throw new Error('disputeId is required');
    if (!params.actor?.trim()) throw new Error('actor is required');
    if (!Object.values(ArbitrationEventType).includes(params.eventType)) {
      throw new Error(`Invalid event type: ${String(params.eventType)}`);
    }

    const seq = this.nextSeq(params.disputeId);

    const entry: ArbitrationLogEntry = {
      id: randomUUID(),
      disputeId: params.disputeId,
      eventType: params.eventType,
      payload: params.payload,
      timestamp: new Date().toISOString(),
      actor: params.actor,
      sequenceNumber: seq,
    };

    const frozen = Object.freeze({ ...entry });
    this.entries.push(frozen);
    return frozen;
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Find a single entry by ID. */
  findById(id: string): Readonly<ArbitrationLogEntry> | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Return all entries for a dispute, ordered by sequence number. */
  getTimeline(disputeId: string): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    return this.entries
      .filter((e) => e.disputeId === disputeId)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  /**
   * Query entries with optional filters and pagination.
   *
   * Results are sorted by timestamp ascending then by sequenceNumber.
   */
  query(q: ArbitrationLogQuery = {}): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    const { disputeId, identity, eventTypes, from, to, limit = 100, offset = 0 } = q;

    let results: readonly ArbitrationLogEntry[] = this.entries;

    if (disputeId) results = results.filter((e) => e.disputeId === disputeId);
    if (identity) results = results.filter((e) => e.actor === identity);
    if (eventTypes?.length) {
      const s = new Set(eventTypes);
      results = results.filter((e) => s.has(e.eventType));
    }
    if (from) results = results.filter((e) => e.timestamp >= from);
    if (to) results = results.filter((e) => e.timestamp <= to);

    results = [...results].sort((a, b) => {
      const cmp = a.timestamp.localeCompare(b.timestamp);
      return cmp !== 0 ? cmp : a.sequenceNumber - b.sequenceNumber;
    });

    return results.slice(offset, offset + limit);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Total number of entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Reset (testing only). */
  clear(): void {
    this.entries.length = 0;
    this.seqCounters.clear();
  }

  /** @internal */
  private nextSeq(disputeId: string): number {
    const cur = this.seqCounters.get(disputeId) ?? 0;
    const next = cur + 1;
    this.seqCounters.set(disputeId, next);
    return next;
  }
}
