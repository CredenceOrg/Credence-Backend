/**
 * @module repositories/arbitrationLogRepository
 * @description Append-only, in-memory repository for {@link ArbitrationLogEntry}
 * records.
 *
 * **Immutability guarantee** – once an entry is appended it is deep-frozen
 * (`Object.freeze`) and can never be mutated or deleted.  All reads return
 * frozen copies so callers cannot accidentally break the audit trail.
 *
 * In a production deployment this would be backed by a persistent store
 * (e.g. PostgreSQL with append-only constraints, or an event-sourcing log).
 */

import type {
  ArbitrationLogEntry,
  ArbitrationLogQuery,
} from '../types/governance.js';

/**
 * In-memory append-only store for arbitration log entries.
 *
 * @example
 * ```ts
 * const repo = new ArbitrationLogRepository();
 * repo.append(entry);
 * const results = repo.query({ disputeId: 'd-1' });
 * ```
 */
export class ArbitrationLogRepository {
  /** Internal ordered list of immutable log entries. */
  private readonly entries: ReadonlyArray<Readonly<ArbitrationLogEntry>> &
    ArbitrationLogEntry[] = [];

  /**
   * Tracks the next sequence number per dispute so each entry receives a
   * monotonically increasing index within its dispute.
   */
  private readonly sequenceCounters = new Map<string, number>();

  // -----------------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------------

  /**
   * Append an entry to the log.
   *
   * The entry is deep-frozen before storage to enforce immutability.
   *
   * @param entry - A fully populated {@link ArbitrationLogEntry}.
   * @returns The frozen entry exactly as stored.
   * @throws {Error} If `entry.id` is empty or already exists.
   */
  append(entry: ArbitrationLogEntry): Readonly<ArbitrationLogEntry> {
    if (!entry.id) {
      throw new Error('ArbitrationLogEntry must have a non-empty id');
    }

    if (this.entries.some((e) => e.id === entry.id)) {
      throw new Error(
        `Duplicate arbitration log entry id: ${entry.id}`,
      );
    }

    const frozen = Object.freeze({ ...entry }) as Readonly<ArbitrationLogEntry>;
    this.entries.push(frozen as ArbitrationLogEntry);
    return frozen;
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single entry by its unique ID.
   *
   * @param id - The entry ID (UUID).
   * @returns The matching entry, or `undefined` if not found.
   */
  findById(id: string): Readonly<ArbitrationLogEntry> | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Query log entries with optional filters, pagination, and ordering.
   *
   * Results are always ordered by `timestamp` ascending (oldest first).
   *
   * @param query - Optional filter / pagination parameters.
   * @returns An array of matching entries.
   */
  query(query: ArbitrationLogQuery = {}): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    const {
      disputeId,
      identity,
      eventTypes,
      from,
      to,
      limit = 100,
      offset = 0,
    } = query;

    let results: readonly Readonly<ArbitrationLogEntry>[] = this.entries;

    if (disputeId !== undefined) {
      results = results.filter((e) => e.disputeId === disputeId);
    }

    if (identity !== undefined) {
      results = results.filter((e) => e.actor === identity);
    }

    if (eventTypes !== undefined && eventTypes.length > 0) {
      const typeSet = new Set(eventTypes);
      results = results.filter((e) => typeSet.has(e.eventType));
    }

    if (from !== undefined) {
      results = results.filter((e) => e.timestamp >= from);
    }

    if (to !== undefined) {
      results = results.filter((e) => e.timestamp <= to);
    }

    // Sort by timestamp ascending, then by sequenceNumber for stability.
    results = [...results].sort((a, b) => {
      const cmp = a.timestamp.localeCompare(b.timestamp);
      return cmp !== 0 ? cmp : a.sequenceNumber - b.sequenceNumber;
    });

    return results.slice(offset, offset + limit);
  }

  /**
   * Return all entries for a given dispute, ordered by sequence number.
   *
   * @param disputeId - The dispute identifier.
   * @returns Ordered array of log entries for the dispute.
   */
  findByDisputeId(disputeId: string): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    return this.entries
      .filter((e) => e.disputeId === disputeId)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  /**
   * Get the next sequence number for a dispute and increment the counter.
   *
   * @param disputeId - The dispute identifier.
   * @returns The next sequence number (starts at 1).
   */
  nextSequenceNumber(disputeId: string): number {
    const current = this.sequenceCounters.get(disputeId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(disputeId, next);
    return next;
  }

  /**
   * Total number of entries in the repository.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Return all entries (read-only). Useful for debugging / testing.
   */
  all(): ReadonlyArray<Readonly<ArbitrationLogEntry>> {
    return [...this.entries];
  }

  /**
   * Reset the repository – **only intended for testing**.
   */
  clear(): void {
    (this.entries as ArbitrationLogEntry[]).length = 0;
    this.sequenceCounters.clear();
  }
}
