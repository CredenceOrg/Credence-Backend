// src/db/repository.ts

export type NodeStatus = 'pending' | 'confirmed' | 'completed' | 'failed';

export interface DbRepository {
  upsertNode(nodeId: string, amount: string): Promise<boolean>;
  updateNodeStatus(nodeId: string, status: string, amount?: string): Promise<boolean>;
  /**
   * Reads the current ingestion lifecycle state for a node.
   *
   * Returns `null` when the node has never been ingested (no `bond` event
   * seen yet). `HorizonListener.handleEvent` uses this as the read half of
   * its read-validate-write transition enforcement; the default stub refuses
   * to manufacture state, so callers must supply a real repository.
   */
  getNodeStatus(nodeId: string): Promise<string | null>;
}

/**
 * In-memory reference implementation of DbRepository.
 *
 * This is a deterministic, side-effect-free store used by the failed-inbound
 * events repository tests and by the HorizonListener in dev/test contexts.
 * It enforces the following invariants:
 *
 *  1. A node must exist before its status can be updated (upsert first).
 *  2. `upsertNode` on an existing node is idempotent and preserves the
 *     existing status/timestamps unless the amount changes.
 *  3. Status transitions are validated against an allowed graph.
 *  4. Concurrent calls for the same node are serialized via a per-node lock.
 */
export class InMemoryDbRepository implements DbRepository {
  private readonly nodes = new Map<string, { amount: string; status: NodeStatus; updatedAt: number }>();
  private readonly locks = new Map<string, Promise<void>>();

  /** Allowed status transitions. A node may only move forward along this graph. */
  private static readonly ALLOWED: ReadonlyMap<NodeStatus, ReadonlySet<NodeStatus>> = new Map([
    ['pending', new Set(['confirmed', 'failed'])],
    ['confirmed', new Set(['completed', 'failed'])],
    ['completed', new Set()],
    ['failed', new Set(['pending'])] // recovery re-drive
  ]);

  private async withLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(nodeId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    this.locks.set(nodeId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(nodeId) === next) {
        this.locks.delete(nodeId);
      }
    }
  }

  async upsertNode(nodeId: string, amount: string): Promise<boolean> {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('upsertNode: nodeId must be a non-empty string');
    }
    if (typeof amount !== 'string' || amount.trim().length === 0) {
      throw new Error('upsertNode: amount must be a non-empty string');
    }
    return this.withLock(nodeId, async () => {
      const existing = this.nodes.get(nodeId);
      if (existing) {
        // Idempotent upsert: only mutate when the amount actually changes.
        if (existing.amount === amount) {
          return false;
        }
        existing.amount = amount;
        existing.updatedAt = Date.now();
        return true;
      }
      this.nodes.set(nodeId, { amount, status: 'pending', updatedAt: Date.now() });
      return true;
    });
  }

  async updateNodeStatus(nodeId: string, status: string, amount?: string): Promise<boolean> {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('updateNodeStatus: nodeId must be a non-empty string');
    }
    if (!this.isValidStatus(status)) {
      throw new Error(`updateNodeStatus: unknown status "${status}"`);
    }
    return this.withLock(nodeId, async () => {
      const existing = this.nodes.get(nodeId);
      if (!existing) {
        // Refuse to manufacture state for unknown nodes.
        return false;
      }
      const next = status as NodeStatus;
      if (existing.status === next) {
        // Idempotent no-op.
        return false;
      }
      const allowed = InMemoryDbRepository.ALLOWED.get(existing.status);
      if (!allowed || !allowed.has(next)) {
        throw new Error(
          `updateNodeStatus: illegal transition ${existing.status} -> ${next} for node ${nodeId}`
        );
      }
      existing.status = next;
      if (amount !== undefined) {
        existing.amount = amount;
      }
      existing.updatedAt = Date.now();
      return true;
    });
  }

  async getNodeStatus(nodeId: string): Promise<string | null> {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('getNodeStatus: nodeId must be a non-empty string');
    }
    const existing = this.nodes.get(nodeId);
    return existing ? existing.status : null;
  }

  /** Test/operational helper: snapshot of a node's stored record. */
  snapshot(nodeId: string): { amount: string; status: NodeStatus; updatedAt: number } | undefined {
    const record = this.nodes.get(nodeId);
    return record ? { ...record } : undefined;
  }

  /** Test only: clear locks and state between cases. */
  reset(): void {
    this.nodes.clear();
    this.locks.clear();
  }

  private isValidStatus(status: string): status is NodeStatus {
    return (
      status === 'pending' ||
      status === 'confirmed' ||
      status === 'completed' ||
      status === 'failed'
    );
  }
}

/**
 * Default repository exported for backward compatibility with existing callers.
 * The default is a fresh in-memory instance; callers that need isolation or a
 * real database should inject their own `DbRepository` implementation.
 */
export const dbRepository: DbRepository = new InMemoryDbRepository();
